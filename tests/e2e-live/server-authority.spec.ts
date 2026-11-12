import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { anonKey, ids, password, sql, stack, staff } from './stack/seed.mjs';
import { reset } from './stack/stack.mjs';

// Server-side authority over the real HTTP surface (GoTrue JWT → PostgREST → RLS/RPC guards).
// The browser hides these actions per role; here we call them directly to prove the UI is not the gate.

type Member = (typeof staff)[keyof typeof staff];

async function session(member: Member) {
  const login = await fetch(`${stack.gateway}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email, password }),
  });
  expect(login.status).toBe(200);
  const { access_token: token } = (await login.json()) as { access_token: string };
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${stack.gateway}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
  };
  const read = async (table: string) => {
    const response = await fetch(`${stack.gateway}/rest/v1/${table}?select=id`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const completed = await call('complete_staff_login', {
    p_device_name: `${member.role} e2e`,
    p_platform: 'Linux',
    p_app_version: '0.1.0',
    p_device: null,
    p_device_token: randomBytes(32).toString('base64url'),
  });
  expect(completed.status).toBe(200);
  return { call, read };
}

test.beforeEach(async () => {
  await reset();
});

test('il server applica ruoli, idempotenza e audit indipendentemente dalla UI', async () => {
  const waiter = await session(staff.waiter);
  const kitchen = await session(staff.kitchen);
  const cashier = await session(staff.cashier);

  const account = await waiter.call('create_account', {
    p_table: ids.table2,
    p_name: 'Rossi',
    p_covers: 2,
    p_note: null,
    p_key: randomUUID(),
  });
  expect(account.status).toBe(200);
  const accountId = (account.body as { id: string }).id;
  const version = Number(sql(`select version from public.accounts where id='${accountId}'`));

  // Idempotenza: lo stesso invio ripetuto (doppio tap, rete instabile) crea un solo ordine.
  const orderKey = randomUUID();
  const items = [
    { dish_id: ids.carbonara, quantity: 1, step: 1, removed_ingredients: [], variant_options: [] },
  ];
  const first = await waiter.call('create_order', {
    p_account: accountId,
    p_items: items,
    p_key: orderKey,
    p_version: version,
  });
  const retry = await waiter.call('create_order', {
    p_account: accountId,
    p_items: items,
    p_key: orderKey,
    p_version: version,
  });
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect((retry.body as { id: string }).id).toBe((first.body as { id: string }).id);
  expect(sql(`select count(*) from public.orders where account_id='${accountId}'`)).toBe('1');

  // Il prezzo è quello del server, non quello del client.
  expect(
    sql(
      `select unit_price_cents from public.order_items i join public.orders o on o.id=i.order_id where o.account_id='${accountId}'`,
    ),
  ).toBe('1400');

  // Ruoli: cameriere e cucina non incassano; la cucina non legge i conti.
  const register = ids.register;
  for (const actor of [waiter, kitchen]) {
    const denied = await actor.call('create_payment', {
      p_account: accountId,
      p_register: register,
      p_amount: 1400,
      p_tip: 0,
      p_method: 'CASH',
      p_key: randomUUID(),
      p_items: [],
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
  }
  const kitchenAccounts = await kitchen.read('accounts');
  expect(kitchenAccounts.status === 200 ? kitchenAccounts.body : []).toEqual([]);
  const kitchenPayments = await kitchen.read('payments');
  expect(kitchenPayments.status === 200 ? kitchenPayments.body : []).toEqual([]);

  // Un client anonimo non apre conti.
  const anonymous = await fetch(`${stack.gateway}/rest/v1/rpc/create_account`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_table: ids.table1,
      p_name: 'X',
      p_covers: 1,
      p_note: null,
      p_key: randomUUID(),
    }),
  });
  expect(anonymous.status).toBeGreaterThanOrEqual(400);

  // La cassa non incassa senza postazione e servizio contabile aperti.
  const closedRegister = await cashier.call('create_payment', {
    p_account: accountId,
    p_register: register,
    p_amount: 1400,
    p_tip: 0,
    p_method: 'CASH',
    p_key: randomUUID(),
    p_items: [],
  });
  expect(closedRegister.status).toBeGreaterThanOrEqual(400);
  expect(sql(`select count(*) from public.payments where account_id='${accountId}'`)).toBe('0');

  // Ogni passaggio lascia traccia nell'audit append-only, attribuita all'attore reale.
  expect(
    sql(
      `select string_agg(distinct actor_role::text, ',' order by actor_role::text) from public.audit_log where account_id='${accountId}'`,
    ),
  ).toBe('WAITER');
  expect(() => sql(`delete from public.audit_log where account_id='${accountId}'`)).toThrow();
});
