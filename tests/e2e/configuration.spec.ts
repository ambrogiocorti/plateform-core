import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
const user = '20000000-0000-4000-8000-000000000001',
  venue = '10000000-0000-4000-8000-000000000001',
  grant = '90000000-0000-4000-8000-000000000001';
async function fixture(page: Page, role: 'ADMIN' | 'SUPER_ADMIN') {
  await page.addInitScript(
    ({ user, role }) => {
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user, aal: 'aal2', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }))}.fixture`;
      localStorage.setItem(
        'plateform-auth-staff',
        JSON.stringify({
          access_token: token,
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id: user,
            aud: 'authenticated',
            role: 'authenticated',
            email: `${role.toLowerCase()}@staff.test`,
            app_metadata: {},
            user_metadata: {},
          },
        }),
      );
    },
    { user, role },
  );
  const commands: { name: string; body: Record<string, unknown> }[] = [];
  const venueData = {
    id: venue,
    name: 'Sede di prova',
    slug: 'sede',
    address: 'Via prova',
    phone: '+390000000000',
    email: null,
    opening_hours: {},
    timezone: 'Europe/Rome',
    currency: 'EUR',
    locale: 'it-IT',
    version: 1,
  };
  const settings = {
    venue_id: venue,
    version: 1,
    reservations_enabled: false,
    customer_ordering: 'WAITER_APPROVAL',
    customer_bill_request: false,
    returns_enabled: false,
    step_starter_roles: ['WAITER', 'PASS', 'KITCHEN_ADMIN'],
    delivery_routing: ['TABLE', 'ZONE'],
    payment_methods: ['CASH', 'CARD_POS'],
    discount_policy: 'ADMIN_APPROVAL_REQUIRED',
    complimentary_policy: 'ADMIN_APPROVAL_REQUIRED',
    sounds: {},
  };
  let probed = false;
  const booking = 'e0000000-0000-4000-8000-000000000002';
  let rectified = false;
  await page.route('**/rest/v1/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!,
      body =
        route.request().method() === 'POST'
          ? (route.request().postDataJSON() as Record<string, unknown>)
          : {};
    commands.push({ name, body });
    let data: unknown = [];
    if (name === 'get_auth_requirements')
      data = {
        role,
        display_name: 'Responsabile test',
        active: true,
        mfa_required: true,
        installation_active: true,
        setup_required: false,
        session_unlocked: true,
        pin_enabled: true,
        password_required: false,
        full_auth_expires_at: new Date(Date.now() + 3600000).toISOString(),
        retry_after_seconds: 0,
      };
    else if (name === 'staff_profiles')
      data = {
        id: user,
        display_name: 'Responsabile test',
        role,
        scope: 'CHAIN',
        active: true,
        version: 1,
      };
    else if (name === 'venues') data = [venueData];
    else if (name === 'feature_flags')
      data = [
        { name: 'MULTI_VENUE', licensed: false },
        { name: 'OFFLINE', licensed: true },
      ];
    else if (name === 'venue_settings') data = settings;
    else if (name === 'get_notification_summary')
      data = { new_count: 0, badge_count: 0, active_count: 0, alerts: [], rules: {} };
    else if (name === 'save_financial_settings' || name === 'save_operational_settings')
      data = { id: venue };
    else if (name === 'get_privacy_configuration')
      data = {
        version: 1,
        retention: {
          reservation_days: 180,
          customer_session_days: 30,
          telemetry_days: 30,
          error_days: 30,
          signal_days: 1,
          enabled: false,
        },
      };
    else if (name === 'search_privacy_reservations')
      data = rectified
        ? []
        : [
            {
              id: booking,
              first_name: 'Anna',
              last_name: 'Bianchi',
              phone: '+39000011111',
              service_date: '2026-10-01',
              slot_time: '19:00',
              status: 'COMPLETED',
              version: 1,
              anonymized_at: null,
              privacy_hold: false,
              privacy_hold_reason: null,
            },
          ];
    else if (name === 'export_reservation_personal_data')
      data = {
        reservation: { first_name: 'Anna', phone: '+39000011111', customer_note: 'Window' },
        answers: [],
      };
    else if (name === 'change_reservation_privacy') {
      rectified = true;
      data = { id: booking, version: 2 };
    } else if (name === 'heartbeat_device') data = true;
    else if (name === 'get_technical_workspace')
      data = {
        profile: { name: 'Ristorante test', status: 'ACTIVE', version: 1 },
        settings: {
          version: 1,
          admin_mfa_required: true,
          cashier_mfa_required: false,
          full_auth_minutes: 120,
          offline_ttl_minutes: 30,
        },
        limits: {
          max_users: 100,
          max_venues: 10,
          max_tables_per_venue: 200,
          max_dishes: 1000,
          max_devices: 100,
          max_storage_bytes: 10737418240,
        },
        features: [
          { name: 'MULTI_VENUE', licensed: false, version: 1 },
          { name: 'OFFLINE', licensed: true, version: 1 },
        ],
        health: probed
          ? [
              {
                component: 'DATABASE',
                status: 'HEALTHY',
                latency_ms: 18,
                checked_at: new Date().toISOString(),
                code: 'PROBE_OK',
              },
            ]
          : [],
        backups: [],
        restores: [],
        backup_health: {
          last_success_at: null,
          last_failure_at: null,
          last_restore_test_at: null,
          last_backup_duration_seconds: null,
          backup_age_minutes: null,
          last_restore_test_duration_seconds: null,
          rpo_within_target: false,
          rto_last_test_within_target: null,
          pending_count: 0,
          failed_24h: 0,
          expiring_7d: 0,
          expired_unpurged_count: 0,
          purge_in_progress_count: 0,
          purge_failed_count: 0,
          last_artifacts_purged_at: null,
          latest_purge_error_code: null,
          latest_status: null,
          latest_integrity_verified: null,
          latest_retention_until: null,
          restore_pending_count: 0,
          restore_failed_24h: 0,
          latest_restore_status: null,
          cron_active: false,
          cron_schedule: null,
        },
        continuity_targets: {
          rpo_target_minutes: 60,
          rto_target_minutes: 120,
          backup_retention_days: 30,
          restore_test_interval_days: 7,
          version: 1,
        },
        releases: [],
        schema_version: null,
        incidents: [],
        usage: { users: 5 },
        queues: { provider_pending: 0 },
        metrics: {
          requests: 0,
          failures: 0,
          error_percent: null,
          latency_p95_ms: null,
          latest_at: null,
        },
      };
    await route.fulfill({ json: data });
  });
  await page.route('**/functions/v1/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    commands.push({ name, body: route.request().postDataJSON() as Record<string, unknown> });
    if (name === 'health-probe') probed = true;
    await route.fulfill({ json: name === 'step-up' ? { grant_id: grant } : { results: [] } });
  });
  return commands;
}
test('Admin saves service flags with a version and an idempotent command', async ({ page }) => {
  const commands = await fixture(page, 'ADMIN');
  await page.goto('http://localhost:5174/impostazioni');
  await expect(page.getByRole('heading', { name: 'Servizio e clienti' })).toBeVisible();
  await page.getByLabel('Prenotazioni online', { exact: true }).check();
  await page.getByLabel('Il cliente può richiedere il conto').check();
  await page.getByLabel('Ordinazione cliente', { exact: true }).selectOption('DISABLED');
  await page.getByRole('button', { name: 'Salva flussi operativi', exact: true }).click();
  await expect
    .poll(() => commands.find((command) => command.name === 'save_operational_settings')?.body)
    .toMatchObject({
      p_venue: venue,
      p_version: 1,
      p_values: {
        reservations_enabled: true,
        customer_bill_request: true,
        customer_ordering: 'DISABLED',
        step_starter_roles: ['WAITER', 'PASS', 'KITCHEN_ADMIN'],
        delivery_routing: ['TABLE', 'ZONE'],
      },
    });
  expect(
    commands.find((command) => command.name === 'save_operational_settings')?.body.p_key,
  ).toMatch(/^[a-f0-9-]{36}$/);
});
test('technical health remains unverified until a real probe result is recorded and hides economic navigation', async ({
  page,
}) => {
  const commands = await fixture(page, 'SUPER_ADMIN');
  await page.goto('http://localhost:5174/salute');
  await expect(page.getByRole('heading', { name: 'Stato dei servizi' })).toBeVisible();
  await expect(page.getByText('RAGGIUNGIBILE', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Cassa', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Statistiche', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Esegui controlli dei servizi', exact: true }).click();
  await expect(page.getByText('RAGGIUNGIBILE', { exact: true })).toBeVisible();
  expect(commands.some((command) => command.name === 'health-probe')).toBe(true);
});

test('Admin verifies identity before exporting and rectifies contacts with a bound password grant', async ({
  page,
}) => {
  const commands = await fixture(page, 'ADMIN');
  await page.goto('http://localhost:5174/privacy');
  await page.getByLabel('Telefono esatto della prenotazione').fill('+39000011111');
  await page.getByRole('button', { name: 'Cerca prenotazioni', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Anna Bianchi' })).toBeVisible();
  await page.getByRole('button', { name: 'Esporta dati personali', exact: true }).click();
  await page.getByLabel('Ho verificato l’identità e il destinatario della richiesta.').check();
  await page.getByRole('button', { name: 'Scarica con verifica password', exact: true }).click();
  await page.getByLabel('La tua password').fill('fixture-password');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Conferma identità', exact: true }).click();
  const download = await downloaded;
  const contents = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(contents.reservation.first_name).toBe('Anna');
  expect(
    commands.find((command) => command.name === 'export_reservation_personal_data')?.body,
  ).toMatchObject({ p_reservation: 'e0000000-0000-4000-8000-000000000002', p_grant: grant });
  await page.getByRole('button', { name: 'Rettifica contatti', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Rettifica dati di contatto' });
  await popup.getByLabel('Nome', { exact: true }).fill('Ann');
  await popup.getByLabel('Telefono', { exact: true }).fill('+39000011112');
  await popup.getByLabel('Motivo della richiesta').fill('Verified correction request');
  await popup.getByLabel('Ho verificato la richiesta e confermo questa operazione.').check();
  await popup.getByRole('button', { name: 'Conferma con password', exact: true }).click();
  await page.getByLabel('La tua password').fill('fixture-password');
  await page.getByRole('button', { name: 'Conferma identità', exact: true }).click();
  await expect
    .poll(() => commands.find((command) => command.name === 'change_reservation_privacy')?.body)
    .toMatchObject({
      p_version: 1,
      p_action: 'RECTIFY',
      p_changes: { first_name: 'Ann', last_name: 'Bianchi', phone: '+39000011112' },
      p_grant: grant,
    });
  await expect(
    page.getByText('Nessuna prenotazione trovata per questo telefono nella sede selezionata.'),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Chiudi', exact: true }).last().click();
  await expect(page.getByRole('navigation', { name: 'Gestionale' })).toBeInViewport();
  expect(
    (await page.getByRole('navigation', { name: 'Gestionale' }).boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  const more = page.locator('details.staff-mobile-more');
  await expect(more).toBeVisible();
  await more.locator('summary').click();
  await expect(more.getByRole('link', { name: 'Sito e branding' })).toBeVisible();
  await expect(more.getByRole('link', { name: 'Audit' })).toBeVisible();
  await expect(more.getByRole('link', { name: 'Dati personali' })).toBeVisible();
  await more.locator('summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/screenshots/privacy-mobile.png' });
});

test('CORE Admin does not see unlicensed food-cost navigation or economic API calls', async ({
  page,
}) => {
  const calls = await fixture(page, 'ADMIN');
  await page.goto('http://localhost:5174/operazioni');
  await expect(page.getByRole('link', { name: 'Food cost e margini' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'FOOD COST' })).toHaveCount(0);
  expect(calls.some((call) => call.name === 'get_menu_engineering')).toBe(false);
  expect(calls.some((call) => call.name === 'get_dish_food_cost')).toBe(false);
});
