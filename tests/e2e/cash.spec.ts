import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Explicit HTTP fixtures verify UI contracts; PostgreSQL tests verify authorization and posting.
const user = '20000000-0000-4000-8000-000000000005',
  venue = '10000000-0000-4000-8000-000000000001';
const register = 'a0000000-0000-4000-8000-000000000010',
  session = 'a0000000-0000-4000-8000-000000000011';
const approval = 'a0000000-0000-4000-8000-000000000012',
  grant = 'a0000000-0000-4000-8000-000000000013';
async function cashFixture(page: Page, pendingApproval = false, showActiveAccount = false) {
  const role = pendingApproval ? 'ADMIN' : 'CASHIER';
  await page.addInitScript(
    ({ id }) => {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: id, exp: expires, role: 'authenticated' }))}.fixture`;
      localStorage.setItem(
        'plateform-auth-staff',
        JSON.stringify({
          access_token: token,
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: expires,
          user: {
            id,
            aud: 'authenticated',
            role: 'authenticated',
            email: 'cash@staff.test',
            app_metadata: {},
            user_metadata: {},
          },
        }),
      );
    },
    { id: user },
  );
  let closed = false;
  const commands: { name: string; body: Record<string, unknown> }[] = [];
  const snapshot = {
    registers: [
      {
        id: register,
        name: 'Cassa principale',
        code: 'C1',
        opening_float_cents: 2000,
        cash_theoretical_cents: 3100,
        amount_cents: 1000,
        tip_cents: 100,
        refund_cents: 0,
        refund_tip_cents: 0,
        methods: [{ method: 'CASH', amount_cents: 1000, tip_cents: 100, entries: 1 }],
      },
    ],
    pending_payments: 0,
    pending_refunds: 0,
    open_accounts: 0,
    closed_accounts: 1,
  };
  await page.route('**/rest/v1/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const body =
      route.request().method() === 'POST'
        ? (route.request().postDataJSON() as Record<string, unknown>)
        : {};
    commands.push({ name, body });
    let data: unknown = [];
    if (name === 'get_notification_summary')
      data = { new_count: 0, badge_count: 0, active_count: 0, alerts: [], rules: {} };
    else if (name === 'get_auth_requirements')
      data = {
        role,
        display_name: 'Operatore cassa',
        active: true,
        mfa_required: false,
        installation_active: true,
        setup_required: false,
        session_unlocked: true,
        pin_enabled: false,
        password_required: false,
        full_auth_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        retry_after_seconds: 0,
      };
    else if (name === 'staff_profiles')
      data = {
        id: user,
        display_name: 'Operatore cassa',
        role,
        scope: 'VENUE',
        active: true,
        version: 1,
      };
    else if (name === 'venues')
      data = [
        {
          id: venue,
          name: 'Sede di prova',
          slug: 'sede',
          address: 'Via prova',
          phone: '+390000000001',
          email: null,
          opening_hours: {},
          timezone: 'Europe/Rome',
          currency: 'EUR',
          locale: 'it-IT',
        },
      ];
    else if (name === 'feature_flags') data = [{ name: 'MULTI_VENUE', licensed: false }];
    else if (name === 'search_accounts')
      data = {
        items: showActiveAccount
          ? [
              {
                id: 'a0000000-0000-4000-8000-000000000021',
                account_name: 'Conto Rossi',
                table_name: 'Tavolo 4',
                covers: 3,
                status: 'OPEN',
                created_at: '2026-10-12T17:15:00Z',
              },
            ]
          : [],
        has_more: false,
      };
    else if (name === 'cash_registers')
      data = [{ id: register, name: 'Cassa principale', code: 'C1', status: 'OPEN' }];
    else if (name === 'service_sessions')
      data = closed
        ? []
        : [
            {
              id: session,
              opened_at: '2026-09-15T10:00:00Z',
              status: pendingApproval ? 'AWAITING_APPROVAL' : 'OPEN',
            },
          ];
    else if (name === 'cash_register_sessions')
      data = closed ? [] : [{ id: session, cash_register_id: register, closed_at: null }];
    else if (name === 'get_service_reconciliation')
      data = {
        ...snapshot,
        status: pendingApproval ? 'AWAITING_APPROVAL' : 'OPEN',
        approval_request: pendingApproval
          ? {
              id: approval,
              actuals: [{ cash_register_id: register, cash_actual_cents: 3090 }],
              snapshot,
            }
          : null,
      };
    else if (name === 'request_service_close' || name === 'resolve_service_reconciliation') {
      closed = true;
      data = { id: session, status: 'CLOSED' };
    }
    await route.fulfill({ json: data });
  });
  await page.route('**/functions/v1/step-up', async (route) => {
    commands.push({
      name: 'step-up',
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    await route.fulfill({ json: { grant_id: grant } });
  });
  return commands;
}

test('Cashier sees the active-account queue without typing a search', async ({ page }) => {
  const commands = await cashFixture(page, false, true);
  await page.goto('http://localhost:5174/cassa');
  await expect(page.getByRole('button', { name: /Tavolo 4 · Conto Rossi/ })).toBeVisible();
  expect(commands.find((row) => row.name === 'search_accounts')?.body).toMatchObject({
    p_search: '',
    p_status: 'ACTIVE',
    p_limit: 20,
  });
});

test('Cashier enters a real count and sends the immutable reconciliation command', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const commands = await cashFixture(page);
  await page.goto('http://localhost:5174/cassa');
  await page.locator('details.cashier-operations > summary').click();
  await page.getByRole('button', { name: 'Quadratura e chiusura' }).click();
  const popup = page.getByRole('dialog', { name: 'Chiudi servizio contabile' });
  await expect(popup.getByText('Contante teorico 31,00', { exact: false })).toBeVisible();
  await expect(popup.getByLabel('Contante reale contato')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/cash-reconciliation-mobile.png', fullPage: true });
  await popup.getByLabel('Contante reale contato').fill('31,00');
  await popup.getByRole('button', { name: 'Conferma conteggio e chiudi' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Servizio chiuso e quadratura salvata.' }),
  ).toBeVisible();
  expect(commands.find((entry) => entry.name === 'request_service_close')?.body).toMatchObject({
    p_session: session,
    p_actuals: [{ cash_register_id: register, cash_actual_cents: 3100 }],
  });
});

test('Admin approves a discrepancy only after the password step-up succeeds', async ({ page }) => {
  const commands = await cashFixture(page, true);
  await page.goto('http://localhost:5174/cassa');
  await page.locator('details.cashier-operations > summary').click();
  await page.getByRole('button', { name: 'Verifica differenza' }).click();
  await page.getByLabel('Motivo della decisione').fill('Differenza verificata nel conteggio');
  await page.getByRole('button', { name: 'Approva e chiudi servizio' }).click();
  await expect(page.getByRole('dialog', { name: 'Conferma la tua identità' })).toBeVisible();
  expect(commands.some((entry) => entry.name === 'resolve_service_reconciliation')).toBe(false);
  await page.getByLabel('La tua password').fill('fixture-password');
  await page.getByRole('button', { name: 'Conferma identità' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Servizio chiuso con approvazione.' }),
  ).toBeVisible();
  expect(commands.find((entry) => entry.name === 'step-up')?.body).toMatchObject({
    action: 'CASH_RECONCILIATION',
    resource_id: approval,
  });
  expect(
    commands.find((entry) => entry.name === 'resolve_service_reconciliation')?.body,
  ).toMatchObject({
    p_request: approval,
    p_approve: true,
    p_grant: grant,
    p_reason: 'Differenza verificata nel conteggio',
  });
});
