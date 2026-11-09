import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { VenueHub, type DeviceBinding } from '../../tools/venue-hub/hub.ts';
import { createHubServer } from '../../tools/venue-hub/server.ts';
import { cook, devices, ids, SEED, tokens } from './fixture';

// Staff sessions opened on the hub with a PIN (ADR-0001, staff access at the
// venue). The PIN is checked by the database's own unlock_staff_session rules
// (attempt counter, exponential lock, full-authentication window); the hub only
// issues a short-lived token bound to the paired device. Loopback HTTP only.

const WAITER_PIN = '482913';
const CASHIER_PIN = '730581';

describe('Venue hub staff sessions with PIN', () => {
  let hub: VenueHub;
  let server: Server;
  let base = '';
  const kitchen = devices.find((d) => d.user_id === cook)!;

  function call(
    path: string,
    init: { method?: string; token?: string | undefined; staff?: string; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${init.token ?? tokens.kitchen}`,
    };
    if (init.staff) headers['x-plateform-staff-session'] = init.staff;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? null : JSON.stringify(init.body),
    }).then(async (res) => ({
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
    }));
  }

  const open = (user_id: string, pin: string, token?: string) =>
    call('/v1/session', { method: 'POST', token, body: { user_id, pin } });

  beforeAll(async () => {
    hub = await VenueHub.open({ hubId: 'hub-sessions', generation: 1, devices });
    await hub.admin(SEED);
    await hub.admin(`insert into private.staff_pins(user_id,pin_hash) values
      ('${ids.waiter}',extensions.crypt('${WAITER_PIN}',extensions.gen_salt('bf',4))),
      ('${ids.cashier}',extensions.crypt('${CASHIER_PIN}',extensions.gen_salt('bf',4)))`);
    const allowedHosts: string[] = [];
    server = createHubServer(hub, { allowedHosts, allowedOrigins: [] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    allowedHosts.push(`127.0.0.1:${port}`);
    base = `http://127.0.0.1:${port}`;
  }, 600_000);

  afterAll(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await hub.close();
  });

  it('lists only names and roles of active staff sharing the venue of the device', async () => {
    const { status, body } = await call('/v1/staff');
    expect(status).toBe(200);
    const staff = body.staff as Record<string, string>[];
    expect(staff.map((s) => s.display_name)).toContain('Cameriere');
    expect(staff.every((s) => Object.keys(s).sort().join() === 'display_name,id,role')).toBe(true);
    expect(staff.some((s) => s.role === 'SUPER_ADMIN')).toBe(false);
  });

  it('opens a session with the right PIN and the person, not the device, acts', async () => {
    const opened = await open(ids.cashier, CASHIER_PIN);
    expect(opened.status).toBe(200);
    const token = opened.body.token as string;
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(Date.parse(opened.body.expires_at as string)).toBeLessThanOrEqual(
      Date.now() + 12 * 3600_000,
    );
    const actor = await hub.actor(kitchen, token);
    expect(actor.user_id).toBe(ids.cashier);
    const read = await call('/v1/table/cash_registers', { staff: token });
    expect(read.status).toBe(200);

    // The token is bound to the paired device that opened it.
    const elsewhere = await call('/v1/table/accounts', { token: tokens.waiter, staff: token });
    expect(elsewhere).toMatchObject({ status: 401, body: { error: 'STAFF_SESSION_INVALID' } });
    // It expires with the hub-side expiry.
    await expect(hub.actor(kitchen, token, new Date(Date.now() + 13 * 3600_000))).rejects.toThrow(
      'STAFF_SESSION_INVALID',
    );
    // Closing revokes it.
    expect((await call('/v1/session', { method: 'DELETE', staff: token })).status).toBe(200);
    const after = await call('/v1/table/accounts', { staff: token });
    expect(after).toMatchObject({ status: 401, body: { error: 'STAFF_SESSION_INVALID' } });
  });

  it('counts wrong PINs in the database, locks, and asks for a full login after five', async () => {
    const wrong = await open(ids.waiter, '000000');
    expect(wrong).toMatchObject({ status: 401, body: { error: 'PIN_INVALID' } });
    // Still inside the exponential lock: even the right PIN is refused.
    const locked = await open(ids.waiter, WAITER_PIN);
    expect(locked).toMatchObject({ status: 401, body: { error: 'PIN_INVALID' } });
    await hub.admin(
      `update private.staff_pins set failed_attempts=4, locked_until=null where user_id='${ids.waiter}'`,
    );
    const last = await open(ids.waiter, '111111');
    expect(last).toMatchObject({ status: 401, body: { error: 'FULL_AUTH_REQUIRED' } });
    await hub.admin(
      `update private.staff_pins set locked_until=null where user_id='${ids.waiter}'`,
    );
    const blocked = await open(ids.waiter, WAITER_PIN);
    expect(blocked).toMatchObject({ status: 401, body: { error: 'FULL_AUTH_REQUIRED' } });
  });

  it('refuses staff without PIN, outside the venue, or with an expired full authentication', async () => {
    expect(await open(cook, '123456')).toMatchObject({
      status: 401,
      body: { error: 'FULL_AUTH_REQUIRED' },
    });
    expect(await open(crypto.randomUUID(), '123456')).toMatchObject({
      status: 403,
      body: { error: 'INVALID_STAFF' },
    });
    expect((await open('not-a-uuid', '123456')).status).toBe(400);
    await hub.admin(
      `update private.staff_sessions set full_auth_at=now()-interval '30 days', full_auth_expires_at=now()-interval '1 day' where user_id='${ids.cashier}'`,
    );
    expect(await open(ids.cashier, CASHIER_PIN)).toMatchObject({
      status: 401,
      body: { error: 'FULL_AUTH_REQUIRED' },
    });
    expect(await call('/v1/table/accounts', { staff: 'x'.repeat(10) })).toMatchObject({
      status: 401,
      body: { error: 'STAFF_SESSION_INVALID' },
    });
  });

  it('keeps the device identity when no staff session is presented', async () => {
    const device: DeviceBinding = kitchen;
    expect(await hub.actor(device)).toBe(device);
  });
});
