import { expect, test } from '@playwright/test';
import { sql, staff } from './stack.mjs';
import { device, licenseProvider, mfaDevice, servedAccount } from './flow';

// Satispay in SANDBOX mode on hosted staging (exploration step): licence, MATCH_CODE payment
// created server-side with the RSA-signed API, redirect page reachable for the guest.
test.setTimeout(360_000);

test('Satispay sandbox: licenza e pagamento MATCH_CODE creato dal server', async ({ browser }) => {
  const superAdmin = await mfaDevice(browser, staff.superAdmin);
  await licenseProvider(superAdmin, 'SATISPAY_API');
  const [waiter, kitchen, pass, cashier] = await Promise.all([
    device(browser, staff.waiter),
    device(browser, staff.kitchen),
    device(browser, staff.pass),
    device(browser, staff.cashier),
  ]);
  sql(`update public.venue_settings set payment_methods=array(select distinct unnest(payment_methods||'{SATISPAY_API}'))
      where venue_id='10000000-0000-4000-8000-0000000000e1';
    update public.cash_registers set payment_methods=array(select distinct unnest(payment_methods||'{SATISPAY_API}'))
      where id='60000000-0000-4000-8000-0000000000e1';`);
  const accountId = await servedAccount({ waiter, kitchen, pass, cashier }, 'Famiglia Satispay');
  await cashier.getByRole('button', { name: 'Registra pagamento' }).click();
  const payment = cashier.getByRole('dialog', { name: 'Registra un pagamento' });
  await payment.getByLabel('Metodo di pagamento').selectOption('SATISPAY_API');
  await payment.getByRole('button', { name: 'Prepara pagamento' }).click();
  const online = cashier.getByRole('dialog', { name: 'Pagamento online' });
  await expect(online).toBeVisible();
  await cashier.waitForTimeout(8000);
  await cashier.screenshot({ path: 'test-results/satispay-cashier.png' });
  console.log('dialog:', (await online.innerText()).replace(/\s+/g, ' '));
  const link = online.getByRole('link', { name: 'Apri pagamento' });
  if (await link.count()) {
    const href = (await link.getAttribute('href'))!;
    console.log('redirect host:', new URL(href).hostname);
    const guest = await (await browser.newContext({ locale: 'it-IT' })).newPage();
    await guest.goto(href);
    await guest.waitForTimeout(5000);
    await guest.screenshot({ path: 'test-results/satispay-guest.png', fullPage: true });
    console.log(
      'guest page:',
      (await guest.locator('body').innerText()).slice(0, 600).replace(/\s+/g, ' '),
    );
  }
  console.log(
    'db:',
    sql(`select p.status||'|'||o.state||'|'||coalesce(o.provider_id,'')||'|'||coalesce(o.last_error,'')
      from public.payments p join public.provider_operations o on o.payment_id=p.id
      where p.account_id='${accountId}'`),
  );
});
