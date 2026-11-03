import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// STEP 7 on the disposable local stack (real GoTrue, PostgREST, PostgreSQL; no Realtime, so
// devices reload): browser print queue with uncertain outcome and verified reprint, Notification
// Center lifecycle that follows the step, and a dish sent back from the table after service.

type Member = (typeof staff)[keyof typeof staff];

async function device(browser: Browser, member: Member): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`[${member.role}] pageerror`, error.message));
  // The CORE browser driver opens the native print dialog; headless Chromium has none.
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(member.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await expect(
    page.getByText(`${member.name} · ${member.role.replaceAll('_', ' ')}`),
  ).toBeVisible();
  return page;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main')).toBeVisible();
}

async function orderCarbonara(waiter: Page, table: string, name: string, withTiramisu = false) {
  await open(waiter, '/servizio');
  const card = waiter.locator('article.waiter-table-card', { hasText: table });
  await card.getByRole('button', { name: 'Nuovo conto' }).click();
  const account = waiter.getByRole('dialog', { name: `Nuovo conto · ${table}` });
  await account.getByLabel('Nome conto').fill(name);
  await account.getByLabel('Coperti').fill('2');
  await account.getByRole('button', { name: 'Crea conto' }).click();
  await waiter
    .getByRole('dialog', { name: 'Conto aperto' })
    .getByRole('button', { name: 'Aggiungi piatti' })
    .click();
  const order = waiter.getByRole('dialog', { name: 'Nuovo ordine' });
  await order
    .locator('article.menu-choice', { hasText: 'Carbonara' })
    .getByLabel('Quantità')
    .fill('1');
  if (withTiramisu)
    await order
      .locator('article.menu-choice', { hasText: 'Tiramisù' })
      .getByLabel('Quantità')
      .fill('1');
  await order.getByRole('button', { name: 'Invia ordine' }).click();
  await expect(waiter.getByText('Ordine inviato alla cucina.')).toBeVisible();
  return waiter.url().split('/').at(-1)!;
}

async function cookAndServe(kitchen: Page, pass: Page, waiter: Page, table: string) {
  await open(kitchen, '/cucina');
  const line = kitchen.locator('section.kitchen-line', { hasText: 'Carbonara' });
  await line.getByRole('button', { name: 'RICEVUTO → PREPARA' }).click();
  await line.getByRole('button', { name: 'SEGNA PRONTO' }).click();
  await expect(line.getByText('READY')).toBeVisible();
  await open(pass, '/pass');
  await pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' }).click();
  await expect(pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' })).toHaveCount(0);
  await open(waiter, '/servizio');
  const delivery = waiter.locator('article.waiter-delivery-card', { hasText: table });
  await delivery.getByRole('button', { name: 'Prendi in carico' }).click();
  await delivery.getByRole('button', { name: 'Conferma consegna al tavolo' }).click();
  await waiter.getByRole('button', { name: 'Sì, piatti consegnati' }).click();
  await expect(waiter.getByText(`${table}: step servito.`)).toBeVisible();
}

const notificationStates = (category: string) =>
  sql(
    `select coalesce(string_agg(status::text, ',' order by created_at),'') from public.notifications where category='${category}'`,
  );

test.beforeEach(async () => {
  await reset();
});

test('stampa comande browser: esito incerto, ristampa verificata e audit', async ({ browser }) => {
  const [admin, waiter, kitchen] = await Promise.all([
    device(browser, staff.admin),
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
  ]);

  // Admin: stampante browser per la cucina e stampa automatica delle nuove comande.
  await open(admin, '/impostazioni');
  await admin.getByRole('button', { name: 'Aggiungi stampante' }).click();
  const printer = admin.getByRole('dialog', { name: 'Nuova stampante' });
  await printer.getByLabel('Nome stampante').fill('Termica cucina');
  await printer.getByLabel('Cucina', { exact: true }).check();
  await printer.getByRole('button', { name: 'Salva stampante' }).click();
  await expect(admin.getByText('Stampante configurata.')).toBeVisible();
  await open(admin, '/impostazioni');
  await admin.getByRole('button', { name: 'Stampante · Cucina calda' }).click();
  const station = admin.getByRole('dialog', { name: 'Stampa comande' });
  await station.getByLabel('Stampante stazione').selectOption({ label: 'Termica cucina' });
  await station.getByLabel('Accoda automaticamente le nuove comande').check();
  await station.getByRole('button', { name: 'Salva stazione' }).click();
  await expect(station).toHaveCount(0);

  // Un ordine con due piatti della stessa stazione produce una sola comanda.
  await orderCarbonara(waiter, 'Tavolo 1', 'Verdi', true);
  expect(
    sql(
      `select string_agg(status::text||':'||jsonb_array_length(payload->'lines'), ',') from public.print_jobs`,
    ),
  ).toBe('QUEUED:2');

  // Cucina: invia la comanda, l'esito è incerto → FAILED, poi ristampa verificata → SUCCESS.
  await open(kitchen, '/stampe');
  const queued = kitchen.locator('article', { hasText: 'Tavolo 1' }).first();
  await queued.getByRole('button', { name: 'Invia alla stampante' }).click();
  const preview = kitchen.getByRole('dialog', { name: 'Anteprima stampa' });
  await expect(preview.getByText('Carbonara')).toBeVisible();
  await expect(preview.getByText('Tiramisù')).toBeVisible();
  await preview.getByRole('button', { name: 'Esito incerto o stampa fallita' }).click();
  await open(kitchen, '/stampe');
  const failed = kitchen.locator('article', { hasText: 'Tavolo 1' }).first();
  await failed.getByRole('button', { name: 'Verifica e ristampa' }).click();
  const reprint = kitchen.getByRole('dialog', { name: 'Conferma ristampa' });
  await reprint
    .getByLabel('Ho verificato il documento fisico e accetto la possibile stampa duplicata.')
    .check();
  await reprint.getByRole('button', { name: 'Accoda ristampa' }).click();
  await kitchen
    .getByRole('dialog', { name: 'Anteprima stampa' })
    .getByRole('button', { name: 'Documento stampato e verificato' })
    .click();

  expect(
    sql(
      `select string_agg(status::text, ',' order by created_at, status::text) from public.print_jobs`,
    ),
  ).toBe('FAILED,SUCCESS');
  expect(
    sql(
      `select string_agg(action, ',' order by timestamp) from public.audit_log where action in ('PRINT_REQUESTED','PRINT_FAILED','PRINT_REPRINT_AUTHORIZED','PRINT_SUCCESS')`,
    ),
  ).toBe('PRINT_REQUESTED,PRINT_FAILED,PRINT_REPRINT_AUTHORIZED,PRINT_SUCCESS');
  expect(
    sql(
      `select string_agg(distinct actor_role::text, ',') from public.audit_log where action in ('PRINT_FAILED','PRINT_SUCCESS')`,
    ),
  ).toBe('KITCHEN_STAFF');
});

test('notifiche dello step si chiudono con il servizio; reso dopo il servizio: RIFARE e annullamento Admin', async ({
  browser,
}) => {
  sql(`update public.venue_settings set returns_enabled=true where venue_id='${ids.venue}'`);
  const [waiter, kitchen, pass, kitchenAdmin, admin] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.kitchenAdmin),
    device(browser, staff.admin),
  ]);

  const accountId = await orderCarbonara(waiter, 'Tavolo 1', 'Neri');
  await open(kitchen, '/cucina');
  const line = kitchen.locator('section.kitchen-line', { hasText: 'Carbonara' });
  await line.getByRole('button', { name: 'RICEVUTO → PREPARA' }).click();
  await line.getByRole('button', { name: 'SEGNA PRONTO' }).click();
  await expect(line.getByText('READY')).toBeVisible();

  // Il Pass vede l'avviso nel Notification Center finché non libera lo step.
  await open(pass, '/notifiche');
  await expect(pass.getByText('Piatti dello step pronti')).toBeVisible();
  await open(pass, '/pass');
  await pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' }).click();
  await expect(pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' })).toHaveCount(0);
  expect(notificationStates('STEP_PREPARED')).toBe('RESOLVED');
  await open(pass, '/notifiche');
  await expect(pass.getByText('Tutto in ordine')).toBeVisible();

  // Il cameriere vede lo step pronto finché non lo serve.
  await open(waiter, '/notifiche');
  await expect(waiter.getByText('Step pronto per il servizio')).toBeVisible();
  expect(notificationStates('STEP_READY')).toBe('NEW');
  await open(waiter, '/servizio');
  const delivery = waiter.locator('article.waiter-delivery-card', { hasText: 'Tavolo 1' });
  await delivery.getByRole('button', { name: 'Prendi in carico' }).click();
  await delivery.getByRole('button', { name: 'Conferma consegna al tavolo' }).click();
  await waiter.getByRole('button', { name: 'Sì, piatti consegnati' }).click();
  await expect(waiter.getByText('Tavolo 1: step servito.')).toBeVisible();
  expect(notificationStates('STEP_READY')).toBe('RESOLVED');
  await open(waiter, '/notifiche');
  await expect(waiter.getByText('Tutto in ordine')).toBeVisible();
  expect(
    sql(`select count(*) from public.audit_log where action='NOTIFICATIONS_AUTO_RESOLVED'`),
  ).toBe('2');

  // Il cliente rimanda indietro il piatto già servito: il Pass lo fa RIFARE.
  const before = Number(
    sql(
      `select availability from public.venue_dish_settings where dish_id='${ids.carbonara}' and venue_id='${ids.venue}'`,
    ),
  );
  await open(pass, '/pass');
  const served = pass.getByRole('region', { name: 'Piatti serviti di recente' });
  await expect(served.getByText('1 × Carbonara')).toBeVisible();
  await served.getByRole('button', { name: 'Piatto tornato indietro' }).click();
  await pass
    .getByRole('dialog', { name: 'Errore ordine' })
    .getByRole('button', { name: 'Rifare il piatto' })
    .click();
  await expect(pass.getByRole('dialog', { name: 'Errore ordine' })).toHaveCount(0);
  await open(kitchen, '/cucina');
  await expect(
    kitchen
      .locator('section.kitchen-line', { hasText: 'Carbonara' })
      .getByRole('button', { name: 'RICEVUTO → PREPARA' }),
  ).toBeVisible();
  expect(
    Number(
      sql(
        `select availability from public.venue_dish_settings where dish_id='${ids.carbonara}' and venue_id='${ids.venue}'`,
      ),
    ),
  ).toBe(before - 1);
  expect(sql(`select string_agg(action, ',') from public.returned_items`)).toBe('REMAKE');

  // Rifatto e servito di nuovo, torna ancora indietro: il Kitchen Admin chiede l'annullamento.
  await cookAndServe(kitchen, pass, waiter, 'Tavolo 1');
  await open(kitchenAdmin, '/cucina');
  const again = kitchenAdmin.getByRole('region', { name: 'Piatti serviti di recente' });
  await again.getByRole('button', { name: 'Piatto tornato indietro' }).click();
  await kitchenAdmin
    .getByRole('dialog', { name: 'Errore ordine' })
    .getByRole('button', { name: 'Richiedi annullamento Admin' })
    .click();
  await expect(kitchenAdmin.getByRole('dialog', { name: 'Errore ordine' })).toHaveCount(0);

  // Senza approvazione Admin l'importo resta sul conto.
  const billed = () =>
    sql(
      `select coalesce(sum(u.gross_cents) filter (where u.voided_at is null),0) from public.billing_units u where u.account_id='${accountId}'`,
    );
  expect(billed()).toBe('1400');
  await open(admin, '/notifiche');
  await expect(admin.getByText('Annullamento piatto reso da autorizzare')).toBeVisible();
  await open(admin, '/modifiche');
  const request = admin.locator('section.card', { hasText: 'Annullamento piatto reso' });
  await request.getByRole('button', { name: 'Apri decisione' }).click();
  const decision = admin.getByRole('dialog', { name: 'Autorizzazione comanda' });
  await decision.getByLabel('Motivo decisione').fill('Errore di comanda verificato');
  await decision.getByRole('button', { name: 'Approva e applica' }).click();
  await expect(decision).toHaveCount(0);
  expect(billed()).toBe('0');
  expect(
    sql(
      `select string_agg(distinct i.status::text, ',') from public.order_items i join public.orders o on o.id=i.order_id where o.account_id='${accountId}'`,
    ),
  ).toBe('CANCELLED');
  expect(sql(`select string_agg(action, ',' order by created_at) from public.returned_items`)).toBe(
    'REMAKE,CANCEL_REQUEST',
  );
  expect(
    sql(
      `select string_agg(actor_role::text, ',' order by timestamp) from public.audit_log where action='ITEM_RETURNED'`,
    ),
  ).toBe('PASS,KITCHEN_ADMIN');
});
