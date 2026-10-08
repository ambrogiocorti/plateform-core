import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const user = '20000000-0000-4000-8000-000000000001',
  venue = '10000000-0000-4000-8000-000000000001';
const account = 'a0000000-0000-4000-8000-000000000007',
  table = 'a0000000-0000-4000-8000-000000000003',
  order = 'a0000000-0000-4000-8000-000000000008';
const register = 'a0000000-0000-4000-8000-000000000010',
  session = 'a0000000-0000-4000-8000-000000000011',
  payment = 'a0000000-0000-4000-8000-000000000020';
const refund = 'a0000000-0000-4000-8000-000000000021',
  grant = 'a0000000-0000-4000-8000-000000000022';
async function accountFixture(
  page: Page,
  role: 'ADMIN' | 'CASHIER',
  discounted = false,
  prepaid = false,
) {
  await page.addInitScript(
    ({ id }) => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: id, exp, role: 'authenticated' }))}.fixture`;
      localStorage.setItem(
        'plateform-auth-staff',
        JSON.stringify({
          access_token: token,
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: exp,
          user: {
            id,
            aud: 'authenticated',
            role: 'authenticated',
            email: 'admin@staff.test',
            app_metadata: {},
            user_metadata: {},
          },
        }),
      );
    },
    { id: user },
  );
  const commands: { name: string; body: Record<string, unknown> }[] = [];
  let refunded = false;
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
        display_name: 'Operatore conto',
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
        display_name: 'Operatore conto',
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
    else if (name === 'get_account_workspace')
      data = {
        account: {
          id: account,
          venue_id: venue,
          account_name: 'Cena Rossi',
          table_id: table,
          table_name: 'Tavolo 1',
          covers: 2,
          status: role === 'ADMIN' ? 'CLOSED' : 'OPEN',
          version: 1,
          floor_released_at: role === 'ADMIN' && !prepaid ? '2026-09-15T12:30:00Z' : null,
          unserved_items: prepaid ? 1 : 0,
        },
        balance: {
          gross_cents: 1000,
          discount_cents: discounted ? 300 : 0,
          total_cents: discounted ? 700 : 1000,
          paid_cents: role === 'ADMIN' ? 1000 : discounted ? 200 : 0,
          pending_cents: 0,
          remaining_cents: role === 'ADMIN' ? 0 : discounted ? 500 : 1000,
          available_cents: role === 'ADMIN' ? 0 : discounted ? 500 : 1000,
        },
        orders: [
          {
            id: order,
            created_at: '2026-09-15T12:00:00Z',
            status: prepaid ? 'READY' : 'SERVED',
            items: [
              {
                id: table,
                dish_name: 'Risotto',
                quantity: 1,
                unit_price_cents: 1000,
                status: prepaid ? 'READY' : 'SERVED',
              },
            ],
          },
        ],
        has_more: false,
      };
    else if (name === 'get_billing_workspace')
      data = {
        version: 1,
        discount_policy: 'CASHIER_AUTONOMOUS',
        complimentary_policy: 'ADMIN_APPROVAL_REQUIRED',
        requests: [],
        items: [
          {
            order_item_id: table,
            dish_name: 'Risotto',
            quantity: 1,
            gross_cents: 1000,
            discount_cents: discounted ? 300 : 0,
            net_cents: discounted ? 700 : 1000,
            paid_cents: role === 'ADMIN' ? 1000 : discounted ? 200 : 0,
            pending_cents: 0,
            available_cents: role === 'ADMIN' ? 0 : discounted ? 500 : 1000,
            selectable_quantity: role === 'ADMIN' ? 0 : 1,
            units: [
              {
                number: 1,
                available_cents: role === 'ADMIN' ? 0 : discounted ? 500 : 1000,
                paid_cents: role === 'ADMIN' ? 1000 : discounted ? 200 : 0,
                pending_cents: 0,
              },
            ],
          },
        ],
      };
    else if (name === 'create_payment') data = { id: payment, status: 'PENDING' };
    else if (name === 'preview_discount')
      data = { version: 1, amount_cents: 70, policy: 'CASHIER_AUTONOMOUS' };
    else if (name === 'request_discount') data = { id: refund, status: 'APPLIED' };
    else if (name === 'get_account_payments')
      data = {
        items:
          role === 'CASHIER'
            ? []
            : [
                {
                  id: payment,
                  cash_register_id: register,
                  register_name: 'Cassa principale',
                  method: 'CASH',
                  amount_cents: 1000,
                  tip_cents: 100,
                  status: refunded ? 'PARTIALLY_REFUNDED' : 'COMPLETED',
                  created_at: '2026-09-15T12:30:00Z',
                  refunded_cents: refunded ? 400 : 0,
                  refunded_tip_cents: 0,
                  refunds: refunded
                    ? [
                        {
                          id: refund,
                          amount_cents: 400,
                          tip_cents: 0,
                          status: 'COMPLETED',
                          reason: 'Rimborso concordato',
                          created_at: '2026-09-15T14:30:00Z',
                        },
                      ]
                    : [],
                },
              ],
        has_more: false,
      };
    else if (name === 'get_payment_registers')
      data = [
        {
          id: register,
          name: 'Cassa principale',
          status: 'OPEN',
          service_session_id: session,
          payment_methods: ['CASH'],
        },
      ];
    else if (name === 'create_refund') {
      refunded = true;
      data = { id: refund, status: 'COMPLETED' };
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

test('a partial manual refund requires Admin password and preserves the original payment in the UI', async ({
  page,
}) => {
  const commands = await accountFixture(page, 'ADMIN');
  await page.goto(`http://localhost:5174/conti/${account}`);
  await expect(page.getByRole('heading', { name: 'Cena Rossi' })).toBeVisible();
  await page.getByRole('button', { name: 'Rimborsa', exact: true }).click();
  await page.getByLabel('Importo da rimborsare').fill('4,00');
  await page.getByLabel('Mancia da rimborsare').fill('0,00');
  await page.getByLabel('Motivo del rimborso').fill('Rimborso concordato');
  await page.getByLabel('Ho verificato la restituzione dell’importo al cliente.').check();
  await page.getByRole('button', { name: 'Autorizza rimborso' }).click();
  expect(commands.some((entry) => entry.name === 'create_refund')).toBe(false);
  await page.getByLabel('La tua password').fill('fixture-password');
  await page.getByRole('button', { name: 'Conferma identità' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Rimborso manuale registrato.' }),
  ).toBeVisible();
  expect(commands.find((entry) => entry.name === 'create_refund')?.body).toMatchObject({
    p_payment: payment,
    p_amount: 400,
    p_tip: 0,
    p_step_up: grant,
    p_register: register,
  });
  await expect(page.getByText('PARTIALLY REFUNDED', { exact: true })).toBeVisible();
  await expect(page.getByText('Rimborso concordato', { exact: true })).toBeVisible();
  expect(commands.some((entry) => ['orders', 'order_items'].includes(entry.name))).toBe(false);
});

test('Cashier sees the balance with normal closure disabled and no Admin correction controls', async ({
  page,
}) => {
  await accountFixture(page, 'CASHIER');
  await page.goto(`http://localhost:5174/conti/${account}`);
  await expect(page.getByRole('button', { name: 'Chiudi conto', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Forza chiusura' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Riapri conto' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registra pagamento' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '1 × Risotto', exact: true })).toBeVisible();
});

test('product payment uses the discounted remainder after an earlier amount payment', async ({
  page,
}) => {
  const commands = await accountFixture(page, 'CASHIER', true);
  await page.goto(`http://localhost:5174/conti/${account}`);
  await page.getByLabel('Quantità da pagare').fill('1');
  await page.getByRole('button', { name: 'Paga prodotti selezionati' }).click();
  await expect(page.getByLabel('Importo del conto')).toHaveValue('5.00');
  await expect(page.getByLabel('Importo del conto')).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Prepara pagamento' }).click();
  await expect(page.getByRole('dialog', { name: 'Conferma l’incasso' })).toBeVisible();
  expect(commands.find((entry) => entry.name === 'create_payment')?.body).toMatchObject({
    p_account: account,
    p_amount: 500,
    p_items: [{ item_id: table, quantity: 1 }],
  });
});

test('percentage discount is previewed on the server and submitted with the reviewed version', async ({
  page,
}) => {
  const commands = await accountFixture(page, 'CASHIER', true);
  await page.goto(`http://localhost:5174/conti/${account}`);
  await page.getByRole('button', { name: 'Sconto o omaggio', exact: true }).click();
  await page.getByLabel('Tipo riduzione').selectOption('PERCENT');
  await page.getByLabel('Importo in euro o percentuale').fill('10,00');
  await page.getByLabel('Motivo della riduzione').fill('Riduzione concordata');
  await page.getByRole('button', { name: 'Calcola riduzione' }).click();
  await expect(page.getByRole('dialog', { name: 'Conferma riduzione' })).toBeVisible();
  expect(commands.some((entry) => entry.name === 'request_discount')).toBe(false);
  await page.getByRole('button', { name: 'Applica riduzione' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Riduzione applicata.' })).toBeVisible();
  expect(commands.find((entry) => entry.name === 'request_discount')?.body).toMatchObject({
    p_account: account,
    p_kind: 'PERCENT',
    p_value: 1000,
    p_version: 1,
    p_reason: 'Riduzione concordata',
  });
});

test('a financially closed prepaid account clearly remains in service until its dishes are delivered', async ({
  page,
}) => {
  await accountFixture(page, 'ADMIN', false, true);
  await page.goto(`http://localhost:5174/conti/${account}`);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Conto chiuso contabilmente. La comanda resta in servizio' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registra pagamento' })).toHaveCount(0);
});
