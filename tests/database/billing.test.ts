import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

const room = 'b0000000-0000-4000-8000-000000000001',
  layout = 'b0000000-0000-4000-8000-000000000002',
  table = 'b0000000-0000-4000-8000-000000000003',
  station = 'b0000000-0000-4000-8000-000000000004';
const category = 'b0000000-0000-4000-8000-000000000005',
  dish = 'b0000000-0000-4000-8000-000000000006',
  account = 'b0000000-0000-4000-8000-000000000007',
  order = 'b0000000-0000-4000-8000-000000000008',
  step = 'b0000000-0000-4000-8000-000000000009',
  register = 'b0000000-0000-4000-8000-000000000010';
const mainItem = 'b0000000-0000-4000-8000-000000000011',
  sideItem = 'b0000000-0000-4000-8000-000000000012';
async function billingFixture(db: PGlite): Promise<void> {
  await seed(db);
  await db.exec(`
      update public.venue_settings set discount_policy='CASHIER_AUTONOMOUS',complimentary_policy='CASHIER_AUTONOMOUS';
      insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
      insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Servizio',true);
      insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}',1,'Tavolo 1',4);
      insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Cucina');
      insert into public.categories(id,name) values('${category}','Piatti');
      insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','Piatto',1000);
      insert into public.accounts(id,venue_id,table_id,account_name,covers,created_by) values('${account}','${ids.venue}','${table}','Conto',3,'${ids.waiter}');
      insert into public.orders(id,venue_id,account_id,origin,created_by,status) values('${order}','${ids.venue}','${account}','WAITER','${ids.waiter}','SERVED');
      insert into public.order_steps(id,venue_id,order_id,step_number,status) values('${step}','${ids.venue}','${order}',1,'SERVED');
      insert into public.order_items(id,venue_id,order_id,step_id,dish_id,station_id,quantity,unit_price_cents,dish_name,category_name,ingredient_snapshot,allergen_snapshot,status) values
        ('${mainItem}','${ids.venue}','${order}','${step}','${dish}','${station}',3,1000,'Piatto','Piatti','[]','[]','SERVED'),
        ('${sideItem}','${ids.venue}','${order}','${step}','${dish}','${station}',1,501,'Contorno','Piatti','[]','[]','SERVED');
      insert into public.cash_registers(id,venue_id,name,code,status) values('${register}','${ids.venue}','Cassa','C1','OPEN');
      insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
    `);
}

describe('Billing units, discounts and mixed settlement', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await billingFixture(db);
  });
  beforeEach(async () => {
    await db.exec('begin');
    await identity(db, ids.cashier);
    await db.query('select public.open_service_session($1,null,$2,0,$3)', [
      ids.venue,
      register,
      crypto.randomUUID(),
    ]);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });
  async function discount(kind = 'PERCENT', value = 500, items: unknown[] = []) {
    const quote = (
      await db.query<{ result: { version: number; amount_cents: number } }>(
        'select public.preview_discount($1,$2,$3,$4) as result',
        [account, kind, value, JSON.stringify(items)],
      )
    ).rows[0]!.result;
    const result = (
      await db.query<{ result: { id: string; status: string } }>(
        "select public.request_discount($1,$2,$3,$4,'Sconto concordato',$5,$6) as result",
        [account, kind, value, JSON.stringify(items), quote.version, crypto.randomUUID()],
      )
    ).rows[0]!.result;
    return { quote, result };
  }
  async function pay(
    amount: number,
    items: unknown[] = [],
    complete = false,
    key = crypto.randomUUID(),
  ) {
    const id = (
      await db.query<{ result: { id: string } }>(
        "select public.create_payment($1,$2,$3,0,'CASH',$4,$5) as result",
        [account, register, amount, key, JSON.stringify(items)],
      )
    ).rows[0]!.result.id;
    if (complete) await db.query('select public.confirm_manual_payment($1,true)', [id]);
    return id;
  }
  async function balance() {
    return (
      await db.query<{
        result: {
          total_cents: number;
          discount_cents: number;
          paid_cents: number;
          pending_cents: number;
          available_cents: number;
        };
      }>('select public.get_account_balance($1) as result', [account])
    ).rows[0]!.result;
  }
  it('backfills existing product and amount payments without changing their historical selections', async () => {
    const legacy = await database(27);
    try {
      await billingFixture(legacy);
      await identity(legacy, ids.cashier);
      await legacy.query('select public.open_service_session($1,null,$2,0,$3)', [
        ids.venue,
        register,
        crypto.randomUUID(),
      ]);
      for (const [amount, items] of [
        [1000, [{ item_id: mainItem, quantity: 1 }]],
        [500, []],
      ] as const) {
        const payment = (
          await legacy.query<{ result: { id: string } }>(
            "select public.create_payment($1,$2,$3,0,'CASH',$4,$5) as result",
            [account, register, amount, crypto.randomUUID(), JSON.stringify(items)],
          )
        ).rows[0]!.result.id;
        await legacy.query('select public.confirm_manual_payment($1,true)', [payment]);
      }
      await legacy.exec('reset role');
      await legacy.exec(
        await readFile('supabase/migrations/20261003170149_billing_units.sql', 'utf8'),
      );
      await identity(legacy, ids.cashier);
      const amounts = (
        await legacy.query(
          'select u.unit_number,a.amount_cents,a.mode from public.payment_unit_allocations a join public.billing_units u on u.id=a.billing_unit_id order by u.unit_number',
        )
      ).rows;
      expect(amounts).toEqual([
        { unit_number: 1, amount_cents: 1000, mode: 'ITEMS' },
        { unit_number: 2, amount_cents: 500, mode: 'AMOUNT' },
      ]);
      const result = (
        await legacy.query<{ result: { paid_cents: number; available_cents: number } }>(
          'select public.get_account_balance($1) as result',
          [account],
        )
      ).rows[0]!.result;
      expect(result).toMatchObject({ paid_cents: 1500, available_cents: 2001 });
    } finally {
      await legacy.close();
    }
  });
  it('allocates percentage-discount remainders exactly and keeps historical unit prices', async () => {
    const { quote, result } = await discount();
    expect(quote.amount_cents).toBe(175);
    expect(result.status).toBe('APPLIED');
    expect(await balance()).toMatchObject({ total_cents: 3326, discount_cents: 175 });
    expect(
      (
        await db.query(
          'select gross_cents,discount_cents from public.billing_units order by order_item_id,unit_number',
        )
      ).rows,
    ).toEqual([
      { gross_cents: 1000, discount_cents: 50 },
      { gross_cents: 1000, discount_cents: 50 },
      { gross_cents: 1000, discount_cents: 50 },
      { gross_cents: 501, discount_cents: 25 },
    ]);
    expect(
      (await db.query('select unit_price_cents from public.order_items where id=$1', [mainItem]))
        .rows[0],
    ).toEqual({ unit_price_cents: 1000 });
  });
  it('applies a previous amount payment to the next product selection and prevents a pending double selection', async () => {
    await discount();
    await pay(350, [], true);
    const selected = await pay(600, [{ item_id: mainItem, quantity: 1 }]);
    expect(await balance()).toMatchObject({
      paid_cents: 350,
      pending_cents: 600,
      available_cents: 2376,
    });
    await db.exec('savepoint duplicate');
    await expect(pay(1900, [{ item_id: mainItem, quantity: 3 }])).rejects.toThrow(
      'ITEM_ALREADY_ALLOCATED',
    );
    await db.exec('rollback to savepoint duplicate');
    await db.query('select public.confirm_manual_payment($1,true)', [selected]);
    await pay(2376, [], true);
    await db.exec('set constraints all immediate');
    expect(await balance()).toMatchObject({
      paid_cents: 3326,
      pending_cents: 0,
      available_cents: 0,
    });
  });
  it('releases a failed selection, preserves its allocation history and handles an idempotent retry', async () => {
    await discount();
    const failed = await pay(950, [{ item_id: mainItem, quantity: 1 }]);
    await db.query('select public.confirm_manual_payment($1,false)', [failed]);
    const key = crypto.randomUUID();
    const paid = await pay(950, [{ item_id: mainItem, quantity: 1 }], true, key);
    expect(await pay(950, [{ item_id: mainItem, quantity: 1 }], false, key)).toBe(paid);
    expect(
      (
        await db.query(
          'select payment_id from public.payment_unit_allocations where payment_id=any($1)',
          [[failed, paid]],
        )
      ).rows,
    ).toHaveLength(2);
    expect(await balance()).toMatchObject({ paid_cents: 950, pending_cents: 0 });
  });
  it('requires a scoped Admin approval grant while keeping the cashier request immutable', async () => {
    await db.exec(
      "reset role; update public.venue_settings set discount_policy='ADMIN_APPROVAL_REQUIRED'",
    );
    await identity(db, ids.cashier);
    const { result } = await discount('FIXED', 101);
    expect(result.status).toBe('PENDING');
    expect(await balance()).toMatchObject({ discount_cents: 0 });
    await db.exec('savepoint forbidden');
    await expect(
      db.query("select public.resolve_discount_request($1,true,'Confermato',1,101,$2,$3)", [
        result.id,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint forbidden');
    await db.exec('reset role');
    const proof = crypto.randomUUID();
    await db.query(
      "insert into private.step_up_grants(id,user_id,session_id,action,resource_id,expires_at) values($1,$2,$3,'DISCOUNT_APPROVAL',$4,now()+interval '1 minute')",
      [proof, ids.admin, sessionId(ids.admin), result.id],
    );
    await identity(db, ids.admin);
    const quote = (
      await db.query<{ result: { version: number; amount_cents: number } }>(
        'select public.preview_discount_request($1) as result',
        [result.id],
      )
    ).rows[0]!.result;
    await db.query(
      "select public.resolve_discount_request($1,true,'Confermato dal responsabile',$2,$3,$4,$5)",
      [result.id, quote.version, quote.amount_cents, proof, crypto.randomUUID()],
    );
    expect(await balance()).toMatchObject({ discount_cents: 101, total_cents: 3400 });
    await db.exec('reset role');
    await expect(
      db.query('update public.discount_requests set value=1 where id=$1', [result.id]),
    ).rejects.toThrow('IMMUTABLE_RECORD');
  });
  it('keeps discount and complimentary policies separate and offers only unsettled products', async () => {
    await db.exec("reset role; update public.venue_settings set discount_policy='DISABLED'");
    await identity(db, ids.cashier);
    await db.exec('savepoint disabled');
    await expect(discount('FIXED', 100)).rejects.toThrow('DISCOUNTS_DISABLED');
    await db.exec('rollback to savepoint disabled');
    await discount('ITEM_COMPLIMENTARY', 0, [{ item_id: mainItem, quantity: 1 }]);
    expect(await balance()).toMatchObject({ discount_cents: 1000, total_cents: 2501 });
    const workspace = (
      await db.query<{ result: { items: { selectable_quantity: number }[] } }>(
        'select public.get_billing_workspace($1) as result',
        [account],
      )
    ).rows[0]!.result;
    expect(workspace.items[0]!.selectable_quantity).toBe(2);
  });
  it('blocks discounts while payment results are pending and rejects cancellation of settled products', async () => {
    const payment = await pay(1000, [{ item_id: mainItem, quantity: 1 }]);
    await db.exec('savepoint pending');
    await expect(discount()).rejects.toThrow('PENDING_PAYMENT_RECONCILIATION_REQUIRED');
    await db.exec('rollback to savepoint pending');
    await db.query('select public.confirm_manual_payment($1,true)', [payment]);
    await db.exec('reset role');
    await expect(
      db.query("update public.order_items set status='CANCELLED' where id=$1", [mainItem]),
    ).rejects.toThrow('SETTLED_ITEM_REQUIRES_CORRECTION');
  });
});
