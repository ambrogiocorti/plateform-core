import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { sql, staff } from './stack.mjs';
import {
  closeDay,
  device,
  licenseProvider,
  mfaDevice,
  open,
  resetTable,
  servedAccount,
  stepUp,
} from './flow';

// Satispay in SANDBOX mode on hosted staging. Paying needs a person with the Satispay sandbox
// phone app, so the spec runs twice: the first run creates the MATCH_CODE payment and writes the
// guest's page to test-results/satispay-link.txt; once the QR is paid in the app, the second run
// checks the server outcome (callback or re-read), closes the account and refunds 5,00 €.
test.setTimeout(600_000);

const methods = `update public.venue_settings set payment_methods=array(select distinct unnest(payment_methods||'{SATISPAY_API}'))
    where venue_id='10000000-0000-4000-8000-0000000000e1';
  update public.cash_registers set payment_methods=array(select distinct unnest(payment_methods||'{SATISPAY_API}'))
    where id='60000000-0000-4000-8000-0000000000e1';`;

test('Satispay sandbox: pagamento MATCH_CODE, esito server, rimborso parziale', async ({
  browser,
}) => {
  const superAdmin = await mfaDevice(browser, staff.superAdmin);
  await licenseProvider(superAdmin, 'SATISPAY_API');
  const [waiter, kitchen, pass, cashier] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.cashier),
  ]);
  sql(methods);
  // An open account that already went through Satispay is resumed (staging keeps its state).
  let accountId = sql(`select p.account_id from public.payments p join public.accounts a
    on a.id=p.account_id where a.status<>'CLOSED' and p.method='SATISPAY_API'
    order by p.created_at desc limit 1`);
  const latest = () =>
    sql(`select id||'|'||status from public.payments where account_id='${accountId}'
      and method='SATISPAY_API' order by created_at desc limit 1`).split('|');
  const online = cashier.getByRole('dialog', { name: 'Pagamento online' });

  if (!accountId || ['FAILED', 'CANCELLED'].includes(latest()[1]!)) {
    accountId ||= await servedAccount({ waiter, kitchen, pass, cashier }, 'Famiglia Satispay');
    await expect(async () => {
      await open(cashier, `/conti/${accountId}`);
      await expect(cashier.getByRole('button', { name: 'Registra pagamento' })).toBeVisible({
        timeout: 3000,
      });
    }).toPass({ timeout: 30_000 });
    await cashier.getByRole('button', { name: 'Registra pagamento' }).click();
    const payment = cashier.getByRole('dialog', { name: 'Registra un pagamento' });
    await payment.getByLabel('Metodo di pagamento').selectOption('SATISPAY_API');
    await payment.getByRole('button', { name: 'Prepara pagamento' }).click();
    const link = online.getByRole('link', { name: 'Apri pagamento' });
    await expect(link).toBeVisible({ timeout: 30_000 });
    const href = (await link.getAttribute('href'))!;
    expect(new URL(href).hostname).toBe('staging-online.satispay.com');
    expect(latest()[1]).toBe('PENDING');
    writeFileSync('test-results/satispay-link.txt', `${href}\n`);
    console.log('SATISPAY_PAYMENT_CREATED: pay the QR in the sandbox app, then run again');
    return;
  }

  const paymentId = latest()[0]!;
  if (latest()[1] === 'PENDING') {
    await open(cashier, `/conti/${accountId}`);
    await cashier.getByRole('button', { name: 'Riprendi verifica online' }).click();
    await expect.poll(() => latest()[1], { timeout: 30_000 }).not.toBe('PENDING');
  }
  console.log(
    'satispay outcome:',
    sql(`select p.status||'|'||o.state from public.payments p join public.provider_operations o
      on o.payment_id=p.id and o.kind='PAYMENT' where p.id='${paymentId}'`),
  );
  expect(
    sql(
      `select method||':'||amount_cents||':'||status from public.payments where id='${paymentId}'`,
    ),
  ).toBe('SATISPAY_API:3450:COMPLETED');
  await open(cashier, `/conti/${accountId}`);
  await cashier.getByRole('button', { name: 'Chiudi conto' }).click();
  await cashier
    .getByRole('dialog', { name: 'Conferma chiusura conto' })
    .getByRole('button', { name: 'Conferma chiusura' })
    .click();
  await expect(cashier.getByText('Conto chiuso.')).toBeVisible();
  await resetTable(waiter);

  const admin = await mfaDevice(browser, staff.admin);
  await open(admin, `/conti/${accountId}`);
  await admin
    .locator('article', { hasText: 'SATISPAY API' })
    .filter({ hasText: 'COMPLETED' })
    .getByRole('button', { name: 'Rimborsa' })
    .click();
  const refund = admin.getByRole('dialog', { name: 'Rimborso totale o parziale' });
  await refund.getByLabel('Importo da rimborsare').fill('5.00');
  await refund.getByLabel('Mancia da rimborsare').fill('0.00');
  await refund.getByLabel('Motivo del rimborso').fill('Prova rimborso Satispay staging');
  await refund.getByRole('button', { name: 'Autorizza rimborso' }).click();
  await stepUp(admin);
  await expect
    .poll(() => sql(`select status from public.refunds where original_payment_id='${paymentId}'`), {
      timeout: 60_000,
    })
    .toBe('COMPLETED');
  expect(sql(`select status from public.payments where id='${paymentId}'`)).toBe(
    'PARTIALLY_REFUNDED',
  );
  await closeDay(cashier);
});
