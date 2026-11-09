import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { VenueHub } from '../../tools/venue-hub/hub.ts';
import { createHubServer } from '../../tools/venue-hub/server.ts';
import { client, devices, dish, ids, SEED, table, tokens } from '../hub/fixture';

// Browser proof for ADR-0001: the real staff UI, paired with a real venue hub
// (all migrations, RLS, RPCs), receives a waiter's order through the hub event
// stream without reloading, and its kitchen action is executed by the hub.
// Cloud calls for login/context are HTTP fixtures; no cloud call carries the
// kitchen board or the transitions. Same machine and loopback HTTP: this is not
// a LAN-01 acceptance test on separate devices.

let hub: VenueHub;
let server: Server;
let base = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  hub = await VenueHub.open({ hubId: 'hub-browser', generation: 1, devices });
  await hub.admin(SEED);
  const allowedHosts: string[] = [];
  server = createHubServer(hub, { allowedHosts, allowedOrigins: ['http://localhost:5174'] });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  base = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await hub.close();
});

async function kitchenDevice(page: Page) {
  const user = '20000000-0000-4000-8000-000000000010';
  await page.addInitScript(
    ({ user, hubUrl, token }) => {
      const jwt = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user, aal: 'aal2', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }))}.fixture`;
      localStorage.setItem(
        'plateform-auth-staff',
        JSON.stringify({
          access_token: jwt,
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id: user,
            aud: 'authenticated',
            role: 'authenticated',
            email: 'cucina@staff.test',
            app_metadata: {},
            user_metadata: {},
          },
        }),
      );
      localStorage.setItem(
        'plateform-venue-hub',
        JSON.stringify({ url: hubUrl, token, label: 'Cucina' }),
      );
    },
    { user, hubUrl: base, token: tokens.kitchen },
  );
  const cloudRpcs: string[] = [];
  await page.route('**/auth/v1/health', (route) => route.fulfill({ json: {} }));
  await page.route('**/rest/v1/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    cloudRpcs.push(name);
    let data: unknown = [];
    if (name === 'get_auth_requirements')
      data = {
        role: 'KITCHEN_STAFF',
        display_name: 'Cuoco',
        active: true,
        mfa_required: false,
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
        display_name: 'Cuoco',
        role: 'KITCHEN_STAFF',
        scope: 'VENUE',
        active: true,
        version: 1,
      };
    else if (name === 'venues')
      data = [
        {
          id: ids.venue,
          name: 'Sede uno',
          slug: 'sede-uno',
          address: 'Via test 1',
          phone: '+390000000001',
          email: null,
          opening_hours: {},
          timezone: 'Europe/Rome',
          currency: 'EUR',
          locale: 'it-IT',
          version: 1,
        },
      ];
    else if (name === 'feature_flags') data = [{ name: 'MULTI_VENUE', licensed: false }];
    else if (name === 'heartbeat_device') data = true;
    else if (name === 'get_notification_summary')
      data = { new_count: 0, badge_count: 0, active_count: 0, alerts: [], rules: {} };
    await route.fulfill({ json: data });
  });
  return cloudRpcs;
}

test('a paired kitchen screen receives a LAN order live and prepares it through the hub', async ({
  page,
}) => {
  const cloudRpcs = await kitchenDevice(page);
  await page.goto('http://localhost:5174/cucina');
  // Hub, cloud and sync are reported separately. The cloud ingest is not built
  // yet (ADR-0001 open item), so hub changes honestly remain pending.
  const badge = page.locator('.connectivity-badge');
  await expect(badge).toHaveText('Sincronizzazione in corso');
  await expect(badge).toHaveAttribute('title', /Hub di sede: raggiungibile/);
  await expect(badge).toHaveAttribute('title', /Sincronizzazione: in attesa di invio al cloud/);
  await expect(page.locator('.kitchen-line')).toHaveCount(0);

  // An independent waiter device sends the order to the hub.
  const waiter = client(base, tokens.waiter);
  const account = await waiter.rpc<{ id: string }>('create_account', {
    p_table: table,
    p_name: 'Rossi',
    p_covers: 2,
    p_note: null,
    p_key: crypto.randomUUID(),
  });
  const [row] = await waiter.read<{ version: number }>('accounts', account.id);
  await waiter.rpc('create_order', {
    p_account: account.id,
    p_items: [{ dish_id: dish, quantity: 2, step: 1 }],
    p_key: crypto.randomUUID(),
    p_version: row!.version,
  });

  // No reload: the hub event stream invalidates the kitchen view.
  const line = page.locator('.kitchen-line', { hasText: 'Carbonara' });
  await expect(line).toHaveCount(1, { timeout: 15_000 });
  await line.getByRole('button', { name: 'RICEVUTO → PREPARA', exact: true }).click();
  await expect(line.getByRole('button', { name: 'SEGNA PRONTO', exact: true })).toBeVisible();

  // A third, independent client observes the state written by the hub.
  const observer = client(base, tokens.kitchen);
  const board = await observer.rpc<{ status: string }[]>('get_kitchen_board', {
    p_venue: ids.venue,
  });
  expect(board.map((item) => item.status)).toEqual(['IN_PREPARATION']);
  expect(cloudRpcs).not.toContain('get_kitchen_board');
  expect(cloudRpcs).not.toContain('transition_order_item');
  // Let the invalidations triggered by the transition settle before the evidence screenshot.
  await page.waitForTimeout(1500);
  await expect(line.getByRole('button', { name: 'SEGNA PRONTO', exact: true })).toBeVisible();
  // Responses from the hub keep the cloud contract: no error toast is shown.
  await expect(page.locator('.toast.error')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/venue-hub-kitchen.png', fullPage: true });
});
