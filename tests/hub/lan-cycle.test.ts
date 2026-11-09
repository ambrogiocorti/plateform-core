import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { VenueHub } from '../../tools/venue-hub/hub.ts';
import { createHubServer } from '../../tools/venue-hub/server.ts';
import { applyBatch, promoteGeneration, ReplicaFenced } from '../../tools/venue-hub/replication.ts';
import { database } from '../database/harness';
import { ids, table, dish, register, table2, tokens, devices, SEED, client } from './fixture';

// Minimal LAN cycle proof for ADR-0001. It runs the real hub (persistent
// embedded PostgreSQL + every versioned migration) behind its HTTP surface and
// drives it with three independent HTTP clients holding distinct device tokens.
// Scope of the evidence: same machine, loopback HTTP, no TLS, no real devices
// or network partition. It does NOT replace acceptance tests LAN-01..LAN-07.

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

    const account = await waiter.rpc<{ id: string; code: string }>('create_account', {
      p_table: table,
      p_name: 'Rossi',
      p_covers: 2,
      p_note: null,
      p_key: accountKey,
    });
    accountId = account.id;
    const [row] = await waiter.read<{ version: number }>('accounts', account.id);
    const items = [{ dish_id: dish, quantity: 2, step: 1 }];
    const order = {
      p_account: account.id,
      p_items: items,
      p_key: orderKey,
      p_version: row!.version,
    };
    await waiter.rpc('create_order', order);
    // Retrying the same command (lost response) must not duplicate the order or stock.
    await waiter.rpc('create_order', order);

    type Ticket = { id: string; step_id: string; version: number };
    const board = await kitchen.rpc<Ticket[]>('get_kitchen_board', { p_venue: ids.venue });
    expect(board).toHaveLength(1);
    const ticket = board[0]!;
    await kitchen.rpc('transition_order_item', {
      p_item: ticket.id,
      p_status: 'IN_PREPARATION',
      p_version: ticket.version,
    });
    await kitchen.rpc('transition_order_item', {
      p_item: ticket.id,
      p_status: 'READY',
      p_version: ticket.version + 1,
    });
    await passClient.rpc('mark_step_ready', { p_step: ticket.step_id });
    await waiter.rpc('deliver_step', { p_step: ticket.step_id, p_served: false });
    await waiter.rpc('deliver_step', { p_step: ticket.step_id, p_served: true });

    // The waiter is not a cashier: payment through the hub is refused server-side.
    await expect(
      waiter.rpc('create_payment', {
        p_account: account.id,
        p_register: register,
        p_amount: 2500,
        p_tip: 0,
        p_method: 'CASH',
        p_key: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    // Online providers are never recorded by the hub, whoever asks.
    await expect(
      cashier.rpc('create_payment', {
        p_account: account.id,
        p_register: register,
        p_amount: 2500,
        p_tip: 0,
        p_method: 'STRIPE',
        p_key: crypto.randomUUID(),
      }),
    ).rejects.toThrow('PAYMENT_METHOD_UNAVAILABLE_ON_LAN');

    await cashier.rpc('open_service_session', {
      p_venue: ids.venue,
      p_service: null,
      p_register: register,
      p_float: 0,
      p_key: crypto.randomUUID(),
    });
    const balance = await cashier.rpc<{ total_cents: number }>('get_account_balance', {
      p_account: account.id,
    });
    expect(balance.total_cents).toBe(2500);
    const payment = await cashier.rpc<{ id: string }>('create_payment', {
      p_account: account.id,
      p_register: register,
      p_amount: 2500,
      p_tip: 0,
      p_method: 'CASH',
      p_key: paymentKey,
    });
    await cashier.rpc('confirm_manual_payment', { p_payment: payment.id, p_success: true });
    await cashier.rpc('close_account', { p_account: account.id });

    const orders = await cashier.read<{ status: string }>('orders');
    expect(orders.map((o) => o.status)).toEqual(['SERVED']);
    const payments = await cashier.read<{ amount_cents: number; status: string }>('payments');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount_cents: 2500 });

    events.abort();
    await pump;
    // The kitchen received venue signals (no business data) and sync progress.
    const lines = received
      .join('')
      .split('\n\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)) as { type: string; venue_id?: string; topic?: string });
    const signals = lines.filter((e) => e.type === 'signal');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((e) => e.venue_id === ids.venue)).toBe(true);
    expect(Object.keys(signals[0]!).sort()).toEqual(
      ['id', 'recipient_user_id', 'topic', 'type', 'venue_id'].sort(),
    );
    expect(lines.some((e) => e.type === 'sync')).toBe(true);
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
    await expect(waiter.rpc('save_staff_profile', {})).rejects.toThrow('RPC_NOT_AVAILABLE_ON_LAN');
    await expect(waiter.read('staff_profiles')).rejects.toThrow('TABLE_NOT_AVAILABLE_ON_LAN');
    // Argument names come from the shared contract: anything else is refused.
    await expect(
      waiter.rpc('close_account', { p_account: crypto.randomUUID(), p_force: true }),
    ).rejects.toThrow('RPC_UNKNOWN_ARGUMENT');
    // Column names in filters are validated against the table definition.
    const bad = await fetch(`${base}/v1/table/accounts?eq.${encodeURIComponent('id;drop')}=1`, {
      headers: { authorization: `Bearer ${tokens.waiter}` },
    });
    expect(bad.status).toBe(400);
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
    await waiter.rpc('create_account', {
      p_table: table2,
      p_name: 'Bianchi',
      p_covers: 3,
      p_note: null,
      p_key: crypto.randomUUID(),
    });
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
