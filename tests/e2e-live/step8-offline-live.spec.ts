import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 8 on the disposable local stack: real GoTrue, PostgREST, PostgreSQL and the repository's
// offline-authorization Edge Function (Deno), signing with a key that exists only on this stack.
// The browser goes really offline (Playwright network emulation): the waiter queues orders in
// IndexedDB, the server verifies them on reconnect, and a rejected one reaches the Conflict
// Center, where the Admin corrects it. Not covered: PWA install/update (dev server, no build).

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
  return page;
}

async function openAccount(waiter: Page, table: string, name: string) {
  await waiter.goto('/servizio');
  const card = waiter.locator('article.waiter-table-card', { hasText: table });
  await card.getByRole('button', { name: 'Nuovo conto' }).click();
  const account = waiter.getByRole('dialog', { name: `Nuovo conto · ${table}` });
  await account.getByLabel('Nome conto').fill(name);
  await account.getByLabel('Coperti').fill('2');
  await account.getByRole('button', { name: 'Crea conto' }).click();
  await expect(waiter.getByRole('dialog', { name: 'Conto aperto' })).toBeVisible();
  return sql(`select id from public.accounts where account_name='${name}'`);
}

async function queueOrder(waiter: Page, account: string, dish: string) {
  await waiter
    .locator('section.card', { hasText: account })
    .getByRole('button', { name: 'Ordine in coda' })
    .click();
  const order = waiter.getByRole('dialog', { name: 'Nuovo ordine' });
  await order.locator('article.menu-choice', { hasText: dish }).getByLabel('Quantità').fill('1');
  await order.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(waiter.getByText('Ordine salvato in coda.', { exact: false })).toBeVisible();
}

const orderLines = (account: string) =>
  sql(`select coalesce(string_agg(i.quantity||'x'||i.dish_name||':'||o.origin,',' order by i.dish_name),'')
    from public.order_items i join public.orders o on o.id=i.order_id where o.account_id='${account}'`);

test.beforeEach(async () => {
  await reset();
  sql(`update public.feature_flags set licensed=true where name='OFFLINE'`);
});

test('offline reale: ordini in coda, verifica del server alla riconnessione, conflitto corretto dall’Admin', async ({
  browser,
}) => {
  const waiter = await device(browser, staff.waiter);
  const rossi = await openAccount(waiter, 'Tavolo 1', 'Famiglia Rossi');
  const bianchi = await openAccount(waiter, 'Tavolo 2', 'Famiglia Bianchi');

  // Online: snapshot firmato dalla Edge Function e dati operativi salvati sul dispositivo.
  await waiter.goto('/servizio');
  await waiter.getByRole('button', { name: 'Profilo' }).click();
  await waiter.getByRole('button', { name: 'Prepara uso offline' }).click();
  await expect(
    waiter.getByText('Sala, comande e operazioni autorizzate preparate per l’uso offline'),
  ).toBeVisible();
  expect(
    sql(
      `select count(*) from public.offline_authorization_snapshots s join auth.users u on u.id=s.user_id where u.email='${staff.waiter.email}'`,
    ),
  ).toBe('1');
  await waiter.keyboard.press('Escape');

  // Rete assente: l'app passa alla modalità offline e accoda gli ordini senza simulare successo.
  await waiter.context().setOffline(true);
  await expect(waiter.getByText('MODALITÀ OFFLINE')).toBeVisible();
  await expect(waiter.getByText(/Autorizzazione valida fino alle/)).toBeVisible();
  await queueOrder(waiter, 'Famiglia Rossi', 'Tiramisù');
  await queueOrder(waiter, 'Famiglia Bianchi', 'Carbonara');
  expect(orderLines(rossi)).toBe('');
  expect(orderLines(bianchi)).toBe('');

  // Nel frattempo la Carbonara finisce (un altro dispositivo, online).
  sql(
    `update public.venue_dish_settings set availability=0 where dish_id='${ids.carbonara}' and venue_id='${ids.venue}'`,
  );

  // Rete di nuovo presente: il server accetta il primo ordine e rifiuta il secondo.
  await waiter.context().setOffline(false);
  await expect.poll(() => orderLines(rossi), { timeout: 30_000 }).toBe('1xTiramisù:OFFLINE');
  await expect
    .poll(
      () =>
        sql(
          `select coalesce(string_agg(reason_code||':'||status,','),'') from public.sync_conflicts`,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe('OUT_OF_STOCK:OPEN');
  expect(orderLines(bianchi)).toBe('');
  expect(
    sql(
      `select string_agg(sync_status::text,',' order by created_at_local) from public.offline_sync_events`,
    ),
  ).toBe('SYNCED,CONFLICT');

  // L'Admin corregge l'ordine rifiutato: la Carbonara esaurita non viene riproposta.
  const admin = await device(browser, staff.admin);
  await admin.goto('/conflitti');
  const card = admin.locator('section.card', {
    hasText: 'Disponibilità esaurita durante la sincronizzazione',
  });
  await expect(card.getByRole('list', { name: 'Righe dell’ordine rifiutato' })).toContainText(
    '1 × Carbonara · step 1',
  );
  await card.getByRole('button', { name: 'Modifica ordine' }).click();
  const editor = admin.getByRole('dialog', { name: 'Modifica ordine' });
  await expect(
    editor.locator('article.menu-choice', { hasText: 'Carbonara' }).getByLabel('Quantità'),
  ).toBeDisabled();
  await editor
    .locator('article.menu-choice', { hasText: 'Tiramisù' })
    .getByLabel('Quantità')
    .fill('1');
  await editor.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(
    admin.getByText('Ordine corretto inviato alla cucina. Conflitto risolto.'),
  ).toBeVisible();
  expect(orderLines(bianchi)).toBe('1xTiramisù:OFFLINE');
  expect(sql(`select status from public.sync_conflicts`)).toBe('RESOLVED');
});
