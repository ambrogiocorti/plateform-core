import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// HTTP contract fixtures exercise the real UI. Server authorization is tested separately in PostgreSQL.
const user = '20000000-0000-4000-8000-000000000003';
const venue = '10000000-0000-4000-8000-000000000001';
const booking = '80000000-0000-4000-8000-000000000006';
const service = '80000000-0000-4000-8000-000000000005';
const table = '80000000-0000-4000-8000-000000000003';
const previousTable = '80000000-0000-4000-8000-000000000014';

async function hostFixture(page: Page, locked = false, initiallyAssigned = false) {
  await page.addInitScript(
    ({ id }) => {
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' }))}.fixture`;
      localStorage.setItem(
        'plateform-auth-staff',
        JSON.stringify({
          access_token: token,
          refresh_token: 'fixture-refresh',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id,
            aud: 'authenticated',
            role: 'authenticated',
            email: 'host@staff.test',
            app_metadata: {},
            user_metadata: {},
          },
        }),
      );
    },
    { id: user },
  );
  const commands: { name: string; body: Record<string, unknown> }[] = [];
  let assignedTable: string | null = initiallyAssigned ? previousTable : null;
  let reservationVersion = initiallyAssigned ? 2 : 1;
  await page.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/').at(-1)!;
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
        role: 'HOST',
        display_name: 'Giulia Host',
        active: true,
        mfa_required: false,
        installation_active: true,
        setup_required: false,
        session_unlocked: !locked,
        pin_enabled: true,
        password_required: false,
        full_auth_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        retry_after_seconds: 0,
      };
    else if (name === 'staff_profiles')
      data = {
        id: user,
        display_name: 'Giulia Host',
        role: 'HOST',
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
          address: 'Via prova 1',
          phone: '+390000000001',
          email: null,
          opening_hours: {},
          timezone: 'Europe/Rome',
          currency: 'EUR',
          locale: 'it-IT',
        },
      ];
    else if (name === 'feature_flags') data = [{ name: 'MULTI_VENUE', licensed: false }];
    else if (name === 'get_floor_workspace')
      data = {
        rooms: [
          {
            id: '80000000-0000-4000-8000-000000000001',
            name: 'Sala principale',
            layout: {
              id: '80000000-0000-4000-8000-000000000002',
              room_id: '80000000-0000-4000-8000-000000000001',
              name: 'Cena',
              width: 1000,
              height: 700,
              version: 1,
              active: true,
              elements: [],
            },
          },
        ],
        tables: [
          {
            id: table,
            room_id: '80000000-0000-4000-8000-000000000001',
            layout_id: '80000000-0000-4000-8000-000000000002',
            name: 'Tavolo 4',
            number: 4,
            seats: 4,
            version: 1,
            zone_id: null,
            shape: 'ROUND',
            position_x: 150,
            position_y: 150,
            width: 100,
            height: 100,
            rotation: 0,
            technical_status: assignedTable === table ? 'RESERVED' : 'AVAILABLE',
            public_table_id: '80000000-0000-4000-8000-000000000009',
            covers: 0,
            open_accounts: 0,
            waiter_name: 'Luca',
            can_open_account: false,
            primary_table_id: null,
          },
        ],
        zones: [],
        labels: [],
      };
    else if (name === 'services') data = [{ id: service, name: 'Cena', active: true }];
    else if (name === 'get_host_reservations')
      data = {
        items: [
          {
            id: booking,
            version: reservationVersion,
            first_name: 'Marta',
            last_name: 'Rossi',
            phone: '+390000000002',
            party_size: 2,
            slot_time: '20:00:00',
            status: 'RESERVED',
            table_id: assignedTable,
            table_name: assignedTable === table ? 'Tavolo 4' : assignedTable ? 'Tavolo 3' : null,
            service_name: 'Cena',
            internal_note: null,
            customer_note: null,
            allergies: 'Latte',
            walk_in: false,
          },
        ],
        has_more: false,
        total: 1,
        covers: 2,
        arrived: 0,
        requested: 0,
      };
    else if (name === 'suggest_tables')
      data = [
        {
          id: table,
          table_ids: [table],
          name: 'Tavolo 4',
          seats: 4,
          zone_id: null,
          requires_merge: false,
        },
      ];
    else if (name === 'assign_table_group') {
      assignedTable = table;
      reservationVersion += 1;
      data = null;
    } else if (name === 'lock_staff_session') {
      locked = true;
      data = null;
    } else if (name === 'unlock_staff_session') {
      locked = body.p_pin !== '192847';
      data = { ok: !locked, password_required: false };
    }
    await route.fulfill({ json: data });
  });
  return commands;
}

test('Host assigns a selected available table and has no financial navigation', async ({
  page,
}) => {
  const commands = await hostFixture(page);
  await page.goto('http://localhost:5174/accoglienza');
  await expect(page.getByRole('heading', { name: 'Marta Rossi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Conti', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Cassa', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dettagli', exact: true }).click();
  await page.getByRole('button', { name: 'Assegna tavolo', exact: true }).click();
  await page.getByRole('button', { name: 'Tavolo 4 · 4 posti' }).click();
  await expect(page.getByText('2 persone · Tavolo 4')).toBeVisible();
  expect(commands.find((command) => command.name === 'assign_table_group')?.body).toEqual({
    p_reservation: booking,
    p_tables: [table],
    p_confirm_change: false,
    p_version: 1,
  });
});

test('Host confirms a table change before submitting the versioned command', async ({ page }) => {
  const commands = await hostFixture(page, false, true);
  await page.goto('http://localhost:5174/accoglienza');
  await expect(page.getByText('2 persone · Tavolo 3')).toBeVisible();
  await page.getByRole('button', { name: 'Dettagli', exact: true }).click();
  await page.getByRole('button', { name: 'Cambia tavolo', exact: true }).click();
  await page.getByRole('button', { name: 'Tavolo 4 · 4 posti' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Conferma cambio tavolo' });
  await expect(confirmation).toBeVisible();
  expect(commands.some((entry) => entry.name === 'assign_table_group')).toBe(false);
  await confirmation.getByRole('button', { name: 'CONFERMA CAMBIO', exact: true }).click();
  await expect(page.getByText('2 persone · Tavolo 4')).toBeVisible();
  expect(commands.find((entry) => entry.name === 'assign_table_group')?.body).toEqual({
    p_reservation: booking,
    p_tables: [table],
    p_confirm_change: true,
    p_version: 2,
  });
});

test('the operational map exposes a keyboard accessible table without Host financial actions', async ({
  page,
}) => {
  await hostFixture(page);
  await page.goto('http://localhost:5174/accoglienza');
  const map = page.getByRole('group', { name: 'Sala principale · Cena' });
  const tableButton = map.getByRole('button', {
    name: 'Tavolo 4 · Disponibile · 0 ospiti · 4 posti · Luca',
  });
  await expect(tableButton).toBeVisible();
  await tableButton.focus();
  await page.keyboard.press('Enter');
  const popup = page.getByRole('dialog', { name: 'Tavolo 4 · 4 coperti' });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Apri un conto' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Visualizza i conti' })).toHaveCount(0);
});

test('a locked session requires a valid PIN before showing operations', async ({ page }) => {
  await hostFixture(page, true);
  await page.goto('http://localhost:5174/accoglienza');
  await expect(page.getByText('Sessione bloccata')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Marta Rossi' })).toHaveCount(0);
  await page.getByLabel('PIN operativo').fill('000000');
  await page.getByRole('button', { name: 'Sblocca', exact: true }).click();
  await expect(
    page.getByText('PIN non valido o attesa ancora attiva.', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('PIN operativo').fill('192847');
  await page.getByRole('button', { name: 'Sblocca', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Marta Rossi' })).toBeVisible();
  await page.getByRole('button', { name: 'Blocca', exact: true }).click();
  await expect(page.getByText('Sessione bloccata')).toBeVisible();
});

test('Host workspace fits a mobile screen and sends its filters to the server', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const commands = await hostFixture(page);
  await page.goto('http://localhost:5174/accoglienza');
  await page.getByLabel('Nome o telefono').fill('Rossi');
  await page.getByRole('button', { name: 'FILTRA', exact: true }).click();
  await expect
    .poll(
      () =>
        commands.filter((entry) => entry.name === 'get_host_reservations').at(-1)?.body.p_search,
    )
    .toBe('Rossi');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/host-mobile.png', fullPage: true });
});
