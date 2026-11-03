import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// Real end-to-end service on the disposable local stack: GoTrue password login, PostgREST RPC,
// PostgreSQL RLS and triggers. Each role runs in its own browser context (separate device:
// own storage, own GoTrue session, own registered device). Realtime is not served locally, so
// devices reload to observe changes made by colleagues; that is a stack limit, not app behavior.

type Member = (typeof staff)[keyof typeof staff];

async function device(browser: Browser, member: Member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${member.landing}$`));
  return page;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main')).toBeVisible();
}

test.beforeEach(async () => {
  await reset();
});

test('servizio completo: tavolo → ordine → cucina → Pass → consegna → cassa → chiusura', async ({
  browser,
}) => {
  const [waiter, kitchen, pass, cashier] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.cashier),
  ]);

  // Cassa: apre la postazione e il servizio contabile.
  await open(cashier, '/cassa');
  await expect(cashier.locator('details.cashier-operations')).toHaveAttribute('open', '');
  const registerCard = cashier.locator('article', { hasText: 'Cassa sala' });
  await registerCard.getByRole('button', { name: 'Apri postazione' }).click();
  await registerCard.getByRole('button', { name: 'Apri servizio contabile' }).click();
  const serviceDialog = cashier.getByRole('dialog', { name: 'Apri servizio · Cassa sala' });
  await serviceDialog.getByLabel('Fondo iniziale').fill('100,00');
  await serviceDialog.getByRole('button', { name: 'Apri servizio' }).click();
  await expect(cashier.getByText('Servizio di cassa aperto.')).toBeVisible();

  // Cameriere: apre il conto al Tavolo 1 e invia l'ordine.
  await open(waiter, '/servizio');
  const tableCard = waiter.locator('article.waiter-table-card', { hasText: 'Tavolo 1' });
  await tableCard.getByRole('button', { name: 'Nuovo conto' }).click();
  const accountDialog = waiter.getByRole('dialog', { name: 'Nuovo conto · Tavolo 1' });
  await accountDialog.getByLabel('Nome conto').fill('Famiglia Bianchi');
  await accountDialog.getByLabel('Coperti').fill('3');
  await accountDialog.getByRole('button', { name: 'Crea conto' }).click();
  const created = waiter.getByRole('dialog', { name: 'Conto aperto' });
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: 'Aggiungi piatti' }).click();
  const order = waiter.getByRole('dialog', { name: 'Nuovo ordine' });
  await order
    .locator('article.menu-choice', { hasText: 'Carbonara' })
    .getByLabel('Quantità')
    .fill('2');
  await order
    .locator('article.menu-choice', { hasText: 'Tiramisù' })
    .getByLabel('Quantità')
    .fill('1');
  await expect(order.getByText('3 pietanze selezionate')).toBeVisible();
  await order.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(waiter.getByText('Ordine inviato alla cucina.')).toBeVisible();
  await expect(waiter).toHaveURL(/\/conti\/[0-9a-f-]{36}$/);
  const accountId = waiter.url().split('/').at(-1)!;

  // Cucina: prende in carico e completa i piatti della propria postazione.
  await open(kitchen, '/cucina');
  // Allergeni congelati nell'ordine (order_items.allergen_snapshot) visibili in cucina.
  await expect(
    kitchen.locator('section.kitchen-line', { hasText: '1 × Tiramisù' }).getByRole('note'),
  ).toHaveText('ALLERGENI: Uova · Latte');
  for (const dish of ['2 × Carbonara', '1 × Tiramisù']) {
    const line = kitchen.locator('section.kitchen-line', { hasText: dish });
    await line.getByRole('button', { name: 'RICEVUTO → PREPARA' }).click();
    await expect(line.getByRole('button', { name: 'SEGNA PRONTO' })).toBeVisible();
    await line.getByRole('button', { name: 'SEGNA PRONTO' }).click();
    await expect(line.getByText('READY')).toBeVisible();
  }

  // Pass: verifica lo step completo e lo libera per il servizio.
  await open(pass, '/pass');
  await expect(pass.getByText('2/2 piatti pronti')).toBeVisible();
  await pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' }).click();
  // Lo step resta visibile al Pass (resi possibili) finché il cameriere non lo consegna.
  await expect(pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' })).toHaveCount(0);
  await expect(pass.locator('.kds-ticket-meta')).toContainText('READY');

  // Cameriere: prende in carico la consegna e conferma il servizio al tavolo.
  await open(waiter, '/servizio');
  const delivery = waiter.locator('article.waiter-delivery-card', { hasText: 'Tavolo 1' });
  await delivery.getByRole('button', { name: 'Prendi in carico' }).click();
  await expect(waiter.getByText('Tavolo 1: consegna presa in carico.')).toBeVisible();
  await delivery.getByRole('button', { name: 'Conferma consegna al tavolo' }).click();
  await waiter.getByRole('button', { name: 'Sì, piatti consegnati' }).click();
  await expect(waiter.getByText('Tavolo 1: step servito.')).toBeVisible();
  await open(pass, '/pass');
  await expect(pass.getByText('Pass libero')).toBeVisible();

  // Cassa: incassa il totale (2×14,00 + 6,50 = 34,50 €) e chiude il conto.
  await open(cashier, `/conti/${accountId}`);
  await expect(cashier.getByText('Famiglia Bianchi').first()).toBeVisible();
  await expect(cashier.getByText('34,50 €').first()).toBeVisible();
  await cashier.getByRole('button', { name: 'Registra pagamento' }).click();
  const payment = cashier.getByRole('dialog', { name: 'Registra un pagamento' });
  await expect(payment.getByLabel('Importo del conto')).toHaveValue('34.50');
  await payment.getByLabel('Metodo di pagamento').selectOption('CARD_POS');
  await payment.getByRole('button', { name: 'Prepara pagamento' }).click();
  const confirm = cashier.getByRole('dialog', { name: 'Conferma l’incasso' });
  await expect(confirm.getByText('34,50 €')).toBeVisible();
  await confirm.getByRole('button', { name: 'Incasso verificato' }).click();
  await expect(
    cashier.getByRole('status').filter({ hasText: 'Pagamento registrato.' }),
  ).toBeVisible();
  await cashier.getByRole('button', { name: 'Chiudi conto' }).click();
  const closing = cashier.getByRole('dialog', { name: 'Conferma chiusura conto' });
  await closing.getByRole('button', { name: 'Conferma chiusura' }).click();
  await expect(cashier.getByText('Conto chiuso.')).toBeVisible();

  // Verifica autorevole lato database: importi interi, stati finali, audit e tavolo liberato.
  expect(sql(`select status from public.accounts where id='${accountId}'`)).toBe('CLOSED');
  expect(
    sql(
      `select method||':'||amount_cents||':'||status from public.payments where account_id='${accountId}'`,
    ),
  ).toBe('CARD_POS:3450:COMPLETED');
  expect(
    sql(
      `select string_agg(distinct i.status::text, ',') from public.order_items i join public.orders o on o.id=i.order_id where o.account_id='${accountId}'`,
    ),
  ).toBe('SERVED');
  expect(
    sql(
      `select string_agg(distinct actor_role::text, ',' order by actor_role::text) from public.audit_log where action in ('PAYMENTS_INSERT','PAYMENTS_UPDATE') and account_id='${accountId}'`,
    ),
  ).toBe('CASHIER');
  await open(waiter, '/servizio');
  await expect(
    waiter.locator('article.waiter-table-card', { hasText: 'Tavolo 1' }).getByText('0 conti'),
  ).toBeVisible();
});
