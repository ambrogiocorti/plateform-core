import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { sql, staff } from './stack.mjs';
import {
  closeDay,
  closeEmptyAccounts,
  device,
  open,
  openDay,
  orderAtTable,
  resetTable,
  serveOrder,
} from './flow';

// Hosted Realtime: colleagues' screens change on their own. The kitchen and Pass pages stay open
// (no reload, no navigation) while the waiter orders and the kitchen marks dishes ready. Each
// change must show within LIVE_MS, well below the 30 s safety poll in src/realtime/live.ts, so
// only a realtime_signals INSERT delivered over the websocket can explain it.
test.setTimeout(300_000);
const LIVE_MS = 10_000;

function countNavigations(page: Page): () => number {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  return () => navigations;
}

/** Serves what is left of the order, cashes it at the POS and closes the account. */
async function cashAndClose(
  waiter: Page,
  kitchen: Page,
  pass: Page,
  cashier: Page,
  accountId: string,
) {
  const unserved = sql(`select count(*) from public.order_items i join public.orders o
    on o.id=i.order_id where o.account_id='${accountId}' and i.status<>'SERVED'`);
  if (unserved !== '0') await serveOrder(waiter, kitchen, pass);
  await open(cashier, `/conti/${accountId}`);
  await expect(cashier.getByText('34,50 €').first()).toBeVisible();
  await cashier.getByRole('button', { name: 'Registra pagamento' }).click();
  const payment = cashier.getByRole('dialog', { name: 'Registra un pagamento' });
  await payment.getByLabel('Metodo di pagamento').selectOption('CARD_POS');
  await payment.getByRole('button', { name: 'Prepara pagamento' }).click();
  await cashier
    .getByRole('dialog', { name: 'Conferma l’incasso' })
    .getByRole('button', { name: 'Incasso verificato' })
    .click();
  await expect(cashier.getByText('Pagamento registrato.')).toBeVisible();
  await cashier.getByRole('button', { name: 'Chiudi conto' }).click();
  await cashier
    .getByRole('dialog', { name: 'Conferma chiusura conto' })
    .getByRole('button', { name: 'Conferma chiusura' })
    .click();
  await expect(cashier.getByText('Conto chiuso.')).toBeVisible();
  expect(sql(`select status from public.accounts where id='${accountId}'`)).toBe('CLOSED');
}

test('Realtime: cucina e Pass si aggiornano senza ricaricare', async ({ browser }) => {
  const [waiter, kitchen, pass, cashier] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.cashier),
  ]);
  // An interrupted earlier run may have left its bill open on Tavolo 1.
  const leftover = sql(`select a.id from public.accounts a where a.status<>'CLOSED'
    and exists(select 1 from public.orders o where o.account_id=a.id)
    and not exists(select 1 from public.payments p where p.account_id=a.id) limit 1`);
  if (leftover) {
    if (sql(`select status from public.cash_registers where code='R1'`) === 'CLOSED')
      await openDay(cashier);
    await cashAndClose(waiter, kitchen, pass, cashier, leftover);
  }
  await closeEmptyAccounts(cashier);
  await closeDay(cashier);
  await resetTable(waiter);
  await openDay(cashier);

  await open(kitchen, '/cucina');
  await open(pass, '/pass');
  for (const page of [kitchen, pass])
    await expect(page.locator('#connection-state')).toHaveText('Aggiornamenti connessi', {
      timeout: 20_000,
    });
  const kitchenNavigations = countNavigations(kitchen);
  const passNavigations = countNavigations(pass);

  const accountId = await orderAtTable(waiter, 'Prova Realtime');
  const lines = ['2 × Carbonara', '1 × Tiramisù'].map((dish) =>
    kitchen.locator('section.kitchen-line', { hasText: dish }),
  );
  for (const line of lines)
    await expect(line.getByRole('button', { name: 'RICEVUTO → PREPARA' })).toBeVisible({
      timeout: LIVE_MS,
    });

  for (const line of lines) {
    await line.getByRole('button', { name: 'RICEVUTO → PREPARA' }).click();
    await line.getByRole('button', { name: 'SEGNA PRONTO' }).click();
    await expect(line.getByText('READY')).toBeVisible();
  }
  await expect(pass.getByRole('button', { name: 'AVVISA E LIBERA LO STEP' })).toBeVisible({
    timeout: LIVE_MS,
  });
  await expect(pass.getByText('2/2 piatti pronti')).toBeVisible();

  expect(kitchenNavigations()).toBe(0);
  expect(passNavigations()).toBe(0);

  // Leave staging as found: serve, cash the bill, reset the table and close the day.
  await cashAndClose(waiter, kitchen, pass, cashier, accountId);
  await resetTable(waiter);
  await closeDay(cashier);
});
