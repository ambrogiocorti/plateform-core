import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { VenueHub, tokenDigest, type DeviceBinding } from '../../tools/venue-hub/hub.ts';
import { createHubServer } from '../../tools/venue-hub/server.ts';
import { applyBatch, promoteGeneration, ReplicaFenced } from '../../tools/venue-hub/replication.ts';
import { database, ids, sessionId } from '../database/harness';

// Minimal LAN cycle proof for ADR-0001. It runs the real hub (persistent
// embedded PostgreSQL + every versioned migration) behind its HTTP surface and
// drives it with three independent HTTP clients holding distinct device tokens.
// Scope of the evidence: same machine, loopback HTTP, no TLS, no real devices
// or network partition. It does NOT replace acceptance tests LAN-01..LAN-07.

const room = '40000000-0000-4000-8000-000000000001';
const layout = '40000000-0000-4000-8000-000000000002';
const table = '40000000-0000-4000-8000-000000000003';
const zone = '40000000-0000-4000-8000-000000000004';
const station = '40000000-0000-4000-8000-000000000005';
const category = '40000000-0000-4000-8000-000000000006';
const dish = '40000000-0000-4000-8000-000000000007';
const register = '60000000-0000-4000-8000-000000000001';
const ingredient = '40000000-0000-4000-8000-000000000008';
const table2 = '40000000-0000-4000-8000-000000000013';
const cook = '20000000-0000-4000-8000-000000000010';
const pass = '20000000-0000-4000-8000-000000000012';

const tokens = {
  waiter: 'waiter-device-token-0123456789abcdef0123456789',
  kitchen: 'kitchen-device-token-0123456789abcdef012345678',
  pass: 'pass-device-token-0123456789abcdef0123456789abc',
  cashier: 'cashier-device-token-0123456789abcdef01234567',
};
const future = new Date(Date.now() + 8 * 3600_000).toISOString();
const devices: DeviceBinding[] = [
  { token: tokens.waiter, user: ids.waiter, label: 'Cameriere tablet' },
  { token: tokens.kitchen, user: cook, label: 'Cucina KDS' },
  { token: tokens.pass, user: pass, label: 'Pass' },
  { token: tokens.cashier, user: ids.cashier, label: 'Cassa' },
].map((d) => ({
  token_sha256: tokenDigest(d.token),
  user_id: d.user,
  session_id: sessionId(d.user),
  label: d.label,
  expires_at: future,
}));

const SEED = `begin;
  insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
    values('Trattoria LAN','https://restaurant.test','https://staff.restaurant.test','staff.test');
  insert into public.restaurant_settings(id) values(true);
  insert into public.system_limits(id) values(true);
  insert into public.venues(id,name,slug,code,address,phone)
    values('${ids.venue}','Sede uno','sede-uno','V1','Via test 1','+390000000001');
  insert into public.venue_settings(venue_id) values('${ids.venue}');
  insert into auth.users(id) values('${ids.admin}'),('${ids.waiter}'),('${ids.cashier}'),('${cook}'),('${pass}');
  insert into public.staff_profiles(id,display_name,role,scope) values
    ('${ids.admin}','Admin','ADMIN','VENUE'),('${ids.waiter}','Cameriere','WAITER','VENUE'),
    ('${ids.cashier}','Cassa','CASHIER','VENUE'),('${cook}','Cuoco','KITCHEN_STAFF','VENUE'),
    ('${pass}','Pass','PASS','VENUE');
  insert into public.staff_venue_assignments(user_id,venue_id) select id,'${ids.venue}' from public.staff_profiles;
  insert into auth.sessions(id,user_id) select replace(id::text,'20000000-','30000000-')::uuid,id from public.staff_profiles;
  insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
    select id,user_id,now(),now()+interval '8 hours' from auth.sessions;
  insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
  insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Cena',true);
  insert into public.zones(id,venue_id,room_id,name) values('${zone}','${ids.venue}','${room}','Interno');
  insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}','${zone}',1,'Tavolo 1',4),
    ('${table2}','${ids.venue}','${room}','${layout}','${zone}',2,'Tavolo 2',4);
  insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Cucina');
  insert into public.table_assignments(venue_id,waiter_id,mode,zone_id) values('${ids.venue}','${ids.waiter}','ZONE','${zone}');
  insert into public.categories(id,name) values('${category}','Primi');
  insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','Carbonara',1250);
  insert into public.ingredients(id,name) values('${ingredient}','Guanciale');
  insert into public.dish_ingredients values('${dish}','${ingredient}',false);
  insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
    values('${ids.venue}','${dish}',10,(now() at time zone 'Europe/Rome')::date,'${station}');
  insert into public.dish_station_assignments values('${ids.venue}','${dish}','${station}',true);
  insert into public.station_staff_assignments values('${ids.venue}','${station}','${cook}',true);
  insert into public.cash_registers(id,venue_id,name,code,status) values('${register}','${ids.venue}','Cassa 1','R1','OPEN');
  insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
commit;`;

function client(base: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    async rpc<T = unknown>(name: string, args: unknown[]) {
      const res = await fetch(`${base}/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ args }),
      });
      const body = (await res.json()) as { result?: T; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP_${res.status}`);
      return body.result as T;
    },
    async read<T = Record<string, unknown>>(table: string, id?: string) {
      const res = await fetch(`${base}/v1/table/${table}${id ? `?id=${id}` : ''}`, { headers });
      const body = (await res.json()) as { rows?: T[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP_${res.status}`);
      return body.rows ?? [];
    },
  };
}

function rawRequest(port: number, headers: Record<string, string>, path = '/v1/health') {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Venue hub LAN cycle (ADR-0001 minimal proof)', () => {
  let dataDir: string;
  let hub: VenueHub;
  let server: Server;
  let base: string;
  let port: number;
  let cloud: PGlite;
  const accountKey = crypto.randomUUID();
  const orderKey = crypto.randomUUID();
  const paymentKey = crypto.randomUUID();
  let accountId = '';

  async function start(generation: number) {
    hub = await VenueHub.open({ dataDir, hubId: 'hub-sede-uno', generation, devices });
    const allowedHosts: string[] = [];
    server = createHubServer(hub, {
      allowedHosts,
      allowedOrigins: ['https://staff.restaurant.test'],
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    allowedHosts.push(`127.0.0.1:${port}`);
    base = `http://127.0.0.1:${port}`;
  }

  async function stop() {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Keep-alive connections from the HTTP clients would otherwise hold the port.
    server.closeAllConnections();
    await closed;
    await hub.close();
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plateform-hub-'));
    port = 0;
    await start(1);
    await hub.admin(SEED);
    cloud = await database();
  }, 600_000);

  afterAll(async () => {
    await stop().catch(() => undefined);
    await cloud?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('runs waiter → kitchen → Pass → delivery → cash payment → close across independent clients', async () => {
    const waiter = client(base, tokens.waiter);
    const kitchen = client(base, tokens.kitchen);
    const passClient = client(base, tokens.pass);
    const cashier = client(base, tokens.cashier);

    // The kitchen subscribes to invalidations before the order is sent.
    const events = new AbortController();
    const stream = await fetch(`${base}/v1/events`, {
      headers: { authorization: `Bearer ${tokens.kitchen}` },
      signal: events.signal,
    });
    const reader = stream.body!.getReader();
    const received: string[] = [];
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        received.push(decoder.decode(value));
      }
    })();

    const account = await waiter.rpc<{ id: string; code: string }>('create_account', [
      table,
      'Rossi',
      2,
      null,
      accountKey,
    ]);
    accountId = account.id;
    const [row] = await waiter.read<{ version: number }>('accounts', account.id);
    const items = [{ dish_id: dish, quantity: 2, step: 1 }];
    await waiter.rpc('create_order', [account.id, items, orderKey, row!.version]);
    // Retrying the same command (lost response) must not duplicate the order or stock.
    await waiter.rpc('create_order', [account.id, items, orderKey, row!.version]);

    type Ticket = { id: string; step_id: string; version: number };
    const board = await kitchen.rpc<Ticket[]>('get_kitchen_board', [ids.venue]);
    expect(board).toHaveLength(1);
    const ticket = board[0]!;
    await kitchen.rpc('transition_order_item', [ticket.id, 'IN_PREPARATION', ticket.version]);
    await kitchen.rpc('transition_order_item', [ticket.id, 'READY', ticket.version + 1]);
    await passClient.rpc('mark_step_ready', [ticket.step_id]);
    await waiter.rpc('deliver_step', [ticket.step_id, false]);
    await waiter.rpc('deliver_step', [ticket.step_id, true]);

    // The waiter is not a cashier: payment through the hub is refused server-side.
    await expect(
      waiter.rpc('create_payment', [
        account.id,
        register,
        2500,
        0,
        'CASH',
        crypto.randomUUID(),
        [],
      ]),
    ).rejects.toThrow();

    await cashier.rpc('open_service_session', [ids.venue, null, register, 0, crypto.randomUUID()]);
    const balance = await cashier.rpc<{ total_cents: number }>('get_account_balance', [account.id]);
    expect(balance.total_cents).toBe(2500);
    const payment = await cashier.rpc<{ id: string }>('create_payment', [
      account.id,
      register,
      2500,
      0,
      'CASH',
      paymentKey,
      [],
    ]);
    await cashier.rpc('confirm_manual_payment', [payment.id, true]);
    await cashier.rpc('close_account', [account.id]);

    const orders = await cashier.read<{ status: string }>('orders');
    expect(orders.map((o) => o.status)).toEqual(['SERVED']);
    const payments = await cashier.read<{ amount_cents: number; status: string }>('payments');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount_cents: 2500 });

    events.abort();
    await pump;
    expect(received.join('')).toContain('"rpc":"create_order"');
  }, 120_000);

  it('rejects unpaired devices, foreign origins, rebinding hosts and non-LAN RPCs', async () => {
    expect(await rawRequest(port, { host: 'evil.example:80' })).toBe(421);
    expect(
      await rawRequest(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }),
    ).toBe(403);
    expect(
      await rawRequest(
        port,
        { host: `127.0.0.1:${port}`, authorization: 'Bearer x'.repeat(10) },
        '/v1/table/accounts',
      ),
    ).toBe(401);
    const intruder = client(base, 'unpaired-token-0123456789abcdef0123456789');
    await expect(intruder.read('accounts')).rejects.toThrow('DEVICE_NOT_PAIRED');
    const waiter = client(base, tokens.waiter);
    await expect(waiter.rpc('save_staff_profile', [])).rejects.toThrow('RPC_NOT_AVAILABLE_ON_LAN');
    await expect(waiter.read('staff_profiles')).rejects.toThrow('TABLE_NOT_AVAILABLE_ON_LAN');
  });

  it('keeps confirmed operations across a hub restart and refuses a generation regression', async () => {
    const before = (await hub.pendingChanges(100000)).length;
    await stop();
    await expect(
      VenueHub.open({ dataDir, hubId: 'hub-sede-uno', generation: 0 + 1, devices }).then(
        async (h) => {
          await h.close();
          return 'opened';
        },
      ),
    ).resolves.toBe('opened');
    await start(2);
    const cashier = client(base, tokens.cashier);
    const [account] = await cashier.read<{ id: string }>('accounts', accountId);
    expect(account?.id).toBe(accountId);
    expect((await hub.pendingChanges(100000)).length).toBe(before);
    await stop();
    await expect(
      VenueHub.open({ dataDir, hubId: 'hub-sede-uno', generation: 1, devices }),
    ).rejects.toThrow('HUB_GENERATION_REGRESSION');
    await expect(
      VenueHub.open({ dataDir, hubId: 'another-hub', generation: 2, devices }),
    ).rejects.toThrow('HUB_DATA_BELONGS_TO_ANOTHER_HUB');
    await start(2);
  }, 300_000);

  it('replicates the change log to the cloud once, idempotently, and fences an older generation', async () => {
    const changes = await hub.pendingChanges(100000);
    expect(changes.length).toBeGreaterThan(0);
    // Batches must not mix generations: replicate generation by generation.
    const byGeneration = new Map<number, typeof changes>();
    for (const c of changes)
      byGeneration.set(c.generation, [...(byGeneration.get(c.generation) ?? []), c]);
    for (const [, batch] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
      await applyBatch(cloud, 'hub-sede-uno', batch);
      // Simulated lost acknowledgement: the same batch is delivered again.
      const replay = await applyBatch(cloud, 'hub-sede-uno', batch);
      expect(replay.applied).toBe(0);
    }
    await hub.acknowledge(changes.at(-1)!.seq);
    expect(await hub.pendingChanges()).toEqual([]);

    const count = async (sql: string) =>
      Number(
        (await cloud.query<{ n: string }>(`select count(*)::text as n from ${sql}`)).rows[0]!.n,
      );
    expect(await count('public.orders')).toBe(1);
    expect(await count('public.order_items')).toBe(1);
    expect(await count(`public.payments where status='COMPLETED'`)).toBe(1);
    expect(
      (
        await cloud.query<{ availability: number }>(
          'select availability from public.venue_dish_settings',
        )
      ).rows[0]?.availability,
    ).toBe(8);
    expect(
      (
        await cloud.query<{ status: string }>('select status from public.accounts where id=$1', [
          accountId,
        ])
      ).rows[0]?.status,
    ).toBe('CLOSED');

    // The replacement hub (generation 2) is promoted on the cloud and writes.
    await promoteGeneration(cloud, 'hub-sede-uno', 2);
    const waiter = client(base, tokens.waiter);
    await waiter.rpc('create_account', [table2, 'Bianchi', 3, null, crypto.randomUUID()]);
    const next = await hub.pendingChanges();
    expect(next.every((c) => c.generation === 2)).toBe(true);
    expect((await applyBatch(cloud, 'hub-sede-uno', next)).applied).toBe(next.length);
    await hub.acknowledge(next.at(-1)!.seq);
    expect(await count(`public.accounts where status<>'CLOSED'`)).toBe(1);

    // A deposed hub (generation 1) reconnecting later cannot write to the cloud,
    // even with sequence numbers the cloud has never seen.
    const stale = [{ ...next.at(-1)!, seq: next.at(-1)!.seq + 1000, generation: 1 }];
    await expect(applyBatch(cloud, 'hub-sede-uno', stale)).rejects.toBeInstanceOf(ReplicaFenced);
  }, 120_000);
});
