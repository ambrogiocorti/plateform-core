import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// HTTP contract fixtures exercise the real UI. Server authorization is tested separately in PostgreSQL.
const user = '20000000-0000-4000-8000-000000000003';
const venue = '10000000-0000-4000-8000-000000000001';
const booking = '80000000-0000-4000-8000-000000000006';
const service = '80000000-0000-4000-8000-000000000005';
const table = '80000000-0000-4000-8000-000000000003';
const secondTable = '80000000-0000-4000-8000-000000000010';

async function hostFixture(page: Page, locked = false, withSecondTable = false) {
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
  let tableAssigned = false;
  let merged = false;
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
    else if (name === 'get_floor_workspace') {
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
            technical_status: tableAssigned ? 'RESERVED' : 'AVAILABLE',
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
      if (withSecondTable) {
        const workspace = data as { tables: Record<string, unknown>[] };
        workspace.tables.push({
          ...workspace.tables[0],
          id: secondTable,
          name: 'Tavolo 5',
          number: 5,
          seats: 2,
          position_x: 450,
          public_table_id: '80000000-0000-4000-8000-000000000011',
          primary_table_id: merged ? table : null,
        });
      }
    } else if (name === 'merge_tables') {
      merged = true;
      data = '80000000-0000-4000-8000-000000000012';
    } else if (name === 'split_tables') {
      merged = false;
      data = null;
    } else if (name === 'services') data = [{ id: service, name: 'Cena', active: true }];
    else if (name === 'get_host_reservations')
      data = {
        items: [
          {
            id: booking,
            version: tableAssigned ? 2 : 1,
            first_name: 'Marta',
            last_name: 'Rossi',
            phone: '+390000000002',
            party_size: 2,
            slot_time: '20:00:00',
            status: 'RESERVED',
            table_id: tableAssigned ? table : null,
            table_name: tableAssigned ? 'Tavolo 4' : null,
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
      tableAssigned = true;
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

test('Host assigns a table with confirmation and has no financial navigation', async ({ page }) => {
  const commands = await hostFixture(page);
  await page.goto('http://localhost:5174/accoglienza');
  await expect(page.getByRole('heading', { name: 'Marta Rossi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Conti', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Cassa', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dettagli', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Marta Rossi' })
    .getByRole('button', { name: 'Assegna tavolo', exact: true })
    .click();
  await page.getByRole('button', { name: 'Tavolo 4 · 4 posti' }).click();
  await page
    .getByRole('dialog', { name: 'Marta Rossi' })
    .getByRole('button', { name: 'Chiudi finestra', exact: true })
    .click();
  await expect(page.getByText('2 persone · Tavolo 4')).toBeVisible();
  expect(commands.find((command) => command.name === 'assign_table_group')?.body).toEqual({
    p_reservation: booking,
    p_tables: [table],
    p_confirm_change: false,
    p_version: 1,
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

test('room filters find tables and keep the real table actions accessible on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await hostFixture(page);
  await page.goto('http://localhost:5174/sala');
  const floor = page.getByRole('region', { name: 'Pianta operativa della sala' });
  await expect(floor.getByText('1 tavolo mostrato', { exact: true })).toBeVisible();
  await expect(floor.getByLabel('Vista sala')).toHaveValue('list');

  await floor.getByLabel('Cerca tavolo o cameriere').fill('INESISTENTE');
  await expect(floor.getByText('Nessun tavolo in questa selezione')).toBeVisible();
  await expect(floor.getByText('0 tavoli mostrati', { exact: true })).toBeVisible();
  await floor.getByRole('button', { name: 'Azzera filtri' }).click();
  await floor.getByLabel('Cerca tavolo o cameriere').fill('luca');
  await floor.getByLabel('Stato del tavolo').selectOption('AVAILABLE');
  const table = floor.getByRole('button', {
    name: 'Tavolo 4 · Disponibile · 0 ospiti · 4 posti · Luca',
  });
  await expect(table).toBeVisible();
  await table.click();
  const popup = page.getByRole('dialog', { name: 'Tavolo 4 · 4 coperti' });
  await expect(popup.getByRole('button', { name: 'QR del tavolo' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Visualizza i conti' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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

test('joined tables stay visible after reload and can be split from the secondary table', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const commands = await hostFixture(page, false, true);
  await page.goto('http://localhost:5174/sala');
  await page.getByRole('button', { name: /^Tavolo 4 ·/ }).click();
  await page.getByRole('button', { name: 'Unisci un tavolo' }).click();
  await page
    .getByRole('dialog', { name: 'Unisci a Tavolo 4' })
    .getByRole('button', { name: 'Conferma', exact: true })
    .click();
  await expect(page.locator('.floor-group-badge')).toHaveCount(2);
  expect(commands.find((entry) => entry.name === 'merge_tables')?.body).toEqual({
    p_primary: table,
    p_secondary: secondTable,
  });
  await page.reload();
  await expect(page.locator('.floor-group-badge')).toHaveCount(2);
  await page.getByLabel('Vista sala').selectOption('map');
  await expect(page.locator('.floor-group-link')).toHaveCount(1);
  await page.getByLabel('Vista sala').selectOption('list');
  await page.getByRole('button', { name: /^Tavolo 5 ·/ }).click();
  const group = page.getByRole('dialog', { name: 'Gruppo tavoli 4 + 5 · 6 posti' });
  await expect(group.getByText('Tavolo principale: Tavolo 4.', { exact: false })).toBeVisible();
  await group.getByRole('button', { name: 'Separa tavoli' }).click();
  await expect(page.locator('.floor-group-badge')).toHaveCount(0);
  await expect(
    page.getByText('Tavoli separati. Ogni tavolo è di nuovo indipendente.'),
  ).toBeVisible();
  expect(commands.find((entry) => entry.name === 'split_tables')?.body).toEqual({
    p_primary: table,
  });
});

test('joining with no eligible tables explains the reason and disables confirmation', async ({
  page,
}) => {
  const commands = await hostFixture(page);
  await page.goto('http://localhost:5174/sala');
  await page.getByRole('button', { name: /^Tavolo 4 ·/ }).click();
  await page.getByRole('button', { name: 'Unisci un tavolo' }).click();
  const selector = page.getByRole('dialog', { name: 'Unisci a Tavolo 4' });
  await expect(selector.getByRole('heading', { name: 'Nessun tavolo disponibile' })).toBeVisible();
  await expect(selector.getByRole('button', { name: 'Conferma', exact: true })).toBeDisabled();
  expect(commands.some((entry) => entry.name === 'merge_tables')).toBe(false);
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

test('error feedback remains visible and dismissible above an open staff dialog', async ({
  page,
}) => {
  await hostFixture(page);
  await page.route('**/rest/v1/rpc/suggest_tables', (route) =>
    route.fulfill({ status: 403, json: { message: 'FORBIDDEN' } }),
  );
  await page.goto('http://localhost:5174/accoglienza');
  await page.getByRole('button', { name: 'Dettagli', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Marta Rossi' });
  await popup.getByRole('button', { name: 'Assegna tavolo', exact: true }).click();
  const feedback = page.locator('.toast.error');
  await expect(popup).toBeVisible();
  await expect(feedback).toBeVisible();
  await expect(feedback.locator('.toast-message')).toHaveText(
    'Non hai il permesso per questa operazione.',
  );
  await feedback.getByRole('button', { name: 'Nascondi avviso' }).click();
  await expect(feedback).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
});
