import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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

// Stripe in TEST mode on hosted staging: licence granted by the SUPER_ADMIN with step-up, a real
// Checkout Session paid with Stripe's test card, the ledger confirmed by the server (webhook or
// re-read of the session), then a partial refund authorised by the ADMIN with step-up.
test.setTimeout(600_000);

async function payOnStripeCheckout(page: Page, url: string) {
  await page.goto(url);
  await page.locator('#email').fill('cliente@e2e.test');
  await page.locator('#cardNumber').fill('4242 4242 4242 4242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Cliente Prova');
  await page.locator('#billingCountry').selectOption('IT');
  // Stripe Link would ask for a phone number: the guest pays with the card only.
  const link = page.locator('#enableStripePass');
  if ((await link.count()) && (await link.isChecked())) await link.uncheck();
  await page.locator('button[type=submit], .SubmitButton').first().click();
  await page.waitForURL(/[?&]payment=/, { timeout: 60_000 });
  await expect(
    page.getByText('Il pagamento è in fase di verifica.', { exact: false }),
  ).toBeVisible();
}

test('Stripe test: licenza, Checkout con carta di prova, esito server, rimborso parziale', async ({
  browser,
}) => {
  const superAdmin = await mfaDevice(browser, staff.superAdmin);
  await licenseProvider(superAdmin, 'STRIPE');

  const [waiter, kitchen, pass, cashier] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.cashier),
  ]);
  // The register and the venue offer Stripe only once it is licensed (database guards).
  sql(`update public.venue_settings set payment_methods=array(select distinct unnest(payment_methods||'{STRIPE}'))
      where venue_id='10000000-0000-4000-8000-0000000000e1';
    update public.cash_registers set payment_methods=array(select distinct unnest(payment_methods||'{STRIPE}'))
      where id='60000000-0000-4000-8000-0000000000e1';`);
  // A run interrupted after the Checkout Session was created resumes on that same payment.
  let accountId = sql(`select p.account_id from public.payments p join public.accounts a
    on a.id=p.account_id where a.status<>'CLOSED' and p.method='STRIPE' limit 1`);
  const online = cashier.getByRole('dialog', { name: 'Pagamento online' });
  const pending = () =>
    sql(
      `select status from public.payments where account_id='${accountId}' and method='STRIPE'`,
    ) === 'PENDING';
  if (!accountId) {
    accountId = await servedAccount({ waiter, kitchen, pass, cashier }, 'Famiglia Stripe');
    await cashier.getByRole('button', { name: 'Registra pagamento' }).click();
    const payment = cashier.getByRole('dialog', { name: 'Registra un pagamento' });
    await payment.getByLabel('Metodo di pagamento').selectOption('STRIPE');
    await payment.getByRole('button', { name: 'Prepara pagamento' }).click();
  } else if (pending()) {
    await open(cashier, `/conti/${accountId}`);
    await cashier.getByRole('button', { name: 'Riprendi verifica online' }).click();
  }
  const paymentId = sql(
    `select id from public.payments where account_id='${accountId}' and method='STRIPE'`,
  );
  if (await online.isVisible()) {
    const link = online.getByRole('link', { name: 'Apri pagamento' });
    const confirmed = online.getByText('Esito confermato dal gestore del pagamento.');
    await expect(link.or(confirmed)).toBeVisible({ timeout: 30_000 });
    if (await link.isVisible()) {
      const checkoutUrl = (await link.getAttribute('href'))!;
      expect(new URL(checkoutUrl).hostname).toBe('checkout.stripe.com');
      expect(pending()).toBe(true);
      const customer = await (await browser.newContext({ locale: 'it-IT' })).newPage();
      await payOnStripeCheckout(customer, checkoutUrl);
      // The webhook normally confirms the payment on its own; the check re-reads Stripe.
      let byWebhook = false;
      for (let i = 0; i < 15 && !byWebhook; i++) {
        byWebhook = !pending();
        if (!byWebhook) await cashier.waitForTimeout(3000);
      }
      console.log(`stripe webhook confirmed payment: ${byWebhook}`);
      // The cashier's check re-reads Stripe; a final outcome refreshes the account view.
      await online.getByRole('button', { name: 'Verifica esito' }).click();
      await expect.poll(pending, { timeout: 20_000 }).toBe(false);
    }
    if (await online.isVisible())
      await online.getByRole('button', { name: 'Torna al conto' }).click();
  }
  expect(
    sql(
      `select method||':'||amount_cents||':'||status from public.payments where id='${paymentId}'`,
    ),
  ).toBe('STRIPE:3450:COMPLETED');
  expect(
    sql(`select state||':'||(provider_id like 'cs_test_%') from public.provider_operations
      where payment_id='${paymentId}' and kind='PAYMENT'`),
  ).toBe('COMPLETED:true');
  await open(cashier, `/conti/${accountId}`);
  await cashier.getByRole('button', { name: 'Chiudi conto' }).click();
  await cashier
    .getByRole('dialog', { name: 'Conferma chiusura conto' })
    .getByRole('button', { name: 'Conferma chiusura' })
    .click();
  await expect(cashier.getByText('Conto chiuso.')).toBeVisible();
  await resetTable(waiter);

  // Admin: rimborso parziale di 5,00 € con nuova verifica della password.
  const admin = await mfaDevice(browser, staff.admin);
  await open(admin, `/conti/${accountId}`);
  await admin
    .locator('article', { hasText: 'STRIPE' })
    .getByRole('button', { name: 'Rimborsa' })
    .click();
  const refund = admin.getByRole('dialog', { name: 'Rimborso totale o parziale' });
  await refund.getByLabel('Importo da rimborsare').fill('5.00');
  await refund.getByLabel('Mancia da rimborsare').fill('0.00');
  await refund.getByLabel('Motivo del rimborso').fill('Prova rimborso parziale staging');
  await refund.getByRole('button', { name: 'Autorizza rimborso' }).click();
  await stepUp(admin);
  // The outcome dialog re-reads Stripe and closes on refresh as soon as the refund is final.
  await expect
    .poll(() => sql(`select status from public.refunds where original_payment_id='${paymentId}'`), {
      timeout: 30_000,
    })
    .toBe('COMPLETED');
  expect(
    sql(`select r.amount_cents||':'||r.status||':'||p.status from public.refunds r
      join public.payments p on p.id=r.original_payment_id where r.original_payment_id='${paymentId}'`),
  ).toBe('500:COMPLETED:PARTIALLY_REFUNDED');

  await closeDay(cashier);
  expect(
    sql(`select status from public.cash_registers where name='Cassa sala' and code='R1'`),
  ).toBe('CLOSED');
});
