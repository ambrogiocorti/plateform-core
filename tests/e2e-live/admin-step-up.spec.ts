import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { active, reset } from './stack/active.mjs';
import { ids, password, sql, staff } from './stack/seed.mjs';
import { session } from './support/api';
import { device, open } from './support/devices';
import { totp } from './support/totp';

// Sensitive actions: Admin login with TOTP MFA, password step-up through the real `step-up` Edge
// Function, and the CORE edition keeping online payment providers closed in the `payments` function.
test.skip(active.mode !== 'supabase', 'Edge Functions are served only by the Supabase CLI stack');

test.beforeEach(async () => {
  await reset();
});

/** A paid and closed account, produced through the same RPCs the UI uses. */
async function closedAccount() {
  const cashier = await session(staff.cashier);
  const waiter = await session(staff.waiter);
  expect(
    (await cashier.call('set_cash_register_open', { p_register: ids.register, p_open: true }))
      .status,
  ).toBe(204);
  expect(
    (
      await cashier.call('open_service_session', {
        p_venue: ids.venue,
        p_service: null,
        p_register: ids.register,
        p_float: 10000,
        p_key: randomUUID(),
      })
    ).status,
  ).toBe(200);
  const account = (
    await waiter.call('create_account', {
      p_table: ids.table1,
      p_name: 'Neri',
      p_covers: 2,
      p_note: null,
      p_key: randomUUID(),
    })
  ).body as { id: string };
  const version = Number(sql(`select version from public.accounts where id='${account.id}'`));
  expect(
    (
      await waiter.call('create_order', {
        p_account: account.id,
        p_items: [
          {
            dish_id: ids.tiramisu,
            quantity: 2,
            step: 1,
            removed_ingredients: [],
            variant_options: [],
          },
        ],
        p_key: randomUUID(),
        p_version: version,
      })
    ).status,
  ).toBe(200);
  const payment = await cashier.call('create_payment', {
    p_account: account.id,
    p_register: ids.register,
    p_amount: 1300,
    p_tip: 0,
    p_method: 'CASH',
    p_key: randomUUID(),
    p_items: [],
  });
  expect(payment.status).toBe(200);
  const paymentId = (payment.body as { id: string }).id;
  expect(
    (await cashier.call('confirm_manual_payment', { p_payment: paymentId, p_success: true }))
      .status,
  ).toBe(200);
  expect((await cashier.call('close_account', { p_account: account.id })).status).toBe(204);
  return { accountId: account.id, paymentId, cashier };
}

test('Admin con MFA riapre un conto chiuso solo dopo la verifica della password', async ({
  browser,
}) => {
  const { accountId } = await closedAccount();
  const { page: admin, totpSecret } = await device(browser, staff.admin);
  expect(totpSecret).toMatch(/^[A-Z2-7]{16,}$/);
  expect(sql(`select count(*) from auth.mfa_factors where status='verified'`)).toBe('1');

  await open(admin, `/conti/${accountId}`);
  await admin.getByRole('button', { name: 'Riapri conto' }).click();
  const editor = admin.getByRole('dialog', { name: 'Riapertura contabile' });
  await editor.getByLabel('Motivo').fill('Errore di battitura sul metodo di pagamento');
  await editor.getByRole('button', { name: 'Conferma riapertura' }).click();

  // Password sbagliata: nessuna autorizzazione, il conto resta chiuso.
  const stepUp = admin.getByRole('dialog', { name: 'Conferma la tua identità' });
  await stepUp.getByLabel('La tua password').fill('password-sbagliata-123');
  await stepUp.getByRole('button', { name: 'Conferma identità' }).click();
  await expect(admin.getByRole('alert').last()).toBeVisible();
  expect(sql(`select status from public.accounts where id='${accountId}'`)).toBe('CLOSED');
  expect(sql(`select count(*) from private.step_up_grants`)).toBe('0');

  // Password corretta: grant monouso, riapertura e audit attribuito all'Admin.
  await stepUp.getByLabel('La tua password').fill(password);
  await stepUp.getByRole('button', { name: 'Conferma identità' }).click();
  await expect(admin.getByText('Conto riaperto.')).toBeVisible();
  expect(sql(`select status from public.accounts where id='${accountId}'`)).not.toBe('CLOSED');
  expect(
    sql(
      `select count(*) from public.audit_log where account_id='${accountId}' and actor_role='ADMIN'`,
    ),
  ).not.toBe('0');
});

test('la cassa non ottiene autorizzazioni da Admin e i pagamenti online restano chiusi in CORE', async () => {
  const { accountId, paymentId, cashier } = await closedAccount();

  // Lo step-up verifica la password ma non concede ruoli: la cassa non può riaprire un conto.
  const grant = await cashier.invoke('step-up', {
    password,
    action: 'REOPEN_ACCOUNT',
    resource_id: accountId,
  });
  expect(grant.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(grant.body)).toContain('FORBIDDEN');
  expect(sql(`select status from public.accounts where id='${accountId}'`)).toBe('CLOSED');

  // Edizione CORE: nessuna preparazione verso Stripe/Satispay, nemmeno chiamando la funzione.
  const online = await cashier.invoke('payments', { payment_id: paymentId });
  expect(online.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(online.body)).toContain('PAYMENT_METHOD_UNLICENSED');
  const stripe = await cashier.call('create_payment', {
    p_account: accountId,
    p_register: ids.register,
    p_amount: 100,
    p_tip: 0,
    p_method: 'STRIPE',
    p_key: randomUUID(),
    p_items: [],
  });
  expect(stripe.status).toBeGreaterThanOrEqual(400);
});

test('il codice TOTP sbagliato non apre la sessione Admin', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Identificativo staff').fill(staff.admin.email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Accedi al servizio' }).click();
  await page.getByText('Inserimento manuale').click();
  const secret = (await page.locator('details code').textContent())!.trim();
  const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, '0');
  await page.getByLabel('Codice di autenticazione').fill(wrong);
  await page.getByRole('button', { name: 'Verifica e accedi' }).click();
  await expect(page.getByRole('alert').last()).toBeVisible();
  await expect(page.getByText(`${staff.admin.name} · ADMIN`)).toHaveCount(0);
  expect(sql(`select count(*) from auth.mfa_factors where status='verified'`)).toBe('0');
});
