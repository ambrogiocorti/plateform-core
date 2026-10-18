import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { reset } from './stack/active.mjs';
import { ids, sql, staff } from './stack/seed.mjs';
import { session } from './support/api';

// Races between devices on the real HTTP surface: the database must serialize them.
test.beforeEach(async () => {
  await reset();
});

async function servedStep() {
  const cashier = await session(staff.cashier);
  const waiter = await session(staff.waiter);
  const kitchen = await session(staff.kitchen);
  const pass = await session(staff.pass);
  await cashier.call('set_cash_register_open', { p_register: ids.register, p_open: true });
  await cashier.call('open_service_session', {
    p_venue: ids.venue,
    p_service: null,
    p_register: ids.register,
    p_float: 0,
    p_key: randomUUID(),
  });
  const account = (
    await waiter.call('create_account', {
      p_table: ids.table1,
      p_name: 'Gialli',
      p_covers: 2,
      p_note: null,
      p_key: randomUUID(),
    })
  ).body as { id: string };
  const version = Number(sql(`select version from public.accounts where id='${account.id}'`));
  await waiter.call('create_order', {
    p_account: account.id,
    p_items: [
      {
        dish_id: ids.carbonara,
        quantity: 1,
        step: 1,
        removed_ingredients: [],
        variant_options: [],
      },
    ],
    p_key: randomUUID(),
    p_version: version,
  });
  const item = sql(
    `select i.id||','||i.step_id from public.order_items i join public.orders o on o.id=i.order_id where o.account_id='${account.id}'`,
  ).split(',');
  for (const [status, itemVersion] of [
    ['IN_PREPARATION', 1],
    ['READY', 2],
  ] as const)
    expect(
      (
        await kitchen.call('transition_order_item', {
          p_item: item[0],
          p_status: status,
          p_version: itemVersion,
        })
      ).status,
    ).toBe(204);
  expect((await pass.call('mark_step_ready', { p_step: item[1] })).status).toBe(204);
  return { accountId: account.id, stepId: item[1]!, waiter, pass, cashier };
}

test('due incassi simultanei dello stesso residuo: ne passa uno solo', async () => {
  const { accountId, cashier } = await servedStep();
  const second = await session(staff.cashier); // seconda postazione dello stesso cassiere
  const attempt = (actor: typeof cashier) =>
    actor.call('create_payment', {
      p_account: accountId,
      p_register: ids.register,
      p_amount: 1400,
      p_tip: 0,
      p_method: 'CASH',
      p_key: randomUUID(),
      p_items: [],
    });
  const results = await Promise.all([attempt(cashier), attempt(second)]);
  expect(results.filter((result) => result.status === 200)).toHaveLength(1);
  expect(
    sql(
      `select coalesce(sum(amount_cents),0) from public.payments where account_id='${accountId}' and status<>'FAILED'`,
    ),
  ).toBe('1400');
});

test('due dispositivi prendono in carico la stessa consegna: vince uno solo', async () => {
  const { stepId, waiter } = await servedStep();
  const otherDevice = await session(staff.waiter);
  const claim = (actor: typeof waiter) =>
    actor.call('deliver_step', { p_step: stepId, p_served: false });
  const results = await Promise.all([claim(waiter), claim(otherDevice)]);
  expect(results.filter((result) => result.status === 204).length).toBeGreaterThanOrEqual(1);
  expect(sql(`select count(*) from public.step_deliveries where step_id='${stepId}'`)).toBe('1');
});
