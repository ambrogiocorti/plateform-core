import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

const room = '40000000-0000-4000-8000-000000000001';
const layout = '40000000-0000-4000-8000-000000000002';
const table = '40000000-0000-4000-8000-000000000003';
const zone = '40000000-0000-4000-8000-000000000004';
const station = '40000000-0000-4000-8000-000000000005';
const category = '40000000-0000-4000-8000-000000000006';
const dish = '40000000-0000-4000-8000-000000000007';
const ingredient = '40000000-0000-4000-8000-000000000008';
const allergen = '40000000-0000-4000-8000-000000000009';
const accountKey = '50000000-0000-4000-8000-000000000001';
const orderKey = '50000000-0000-4000-8000-000000000002';
const register = '60000000-0000-4000-8000-000000000001';
const serviceKey = '60000000-0000-4000-8000-000000000002';
const paymentKey = '60000000-0000-4000-8000-000000000003';
const cook = '20000000-0000-4000-8000-000000000010';
const observer = '20000000-0000-4000-8000-000000000011';
const pass = '20000000-0000-4000-8000-000000000012';
const customer = '20000000-0000-4000-8000-000000000013';
const customer2 = '20000000-0000-4000-8000-000000000017';
const tableWaiter = '20000000-0000-4000-8000-000000000014';
const runner = '20000000-0000-4000-8000-000000000015';
const kitchenAdmin = '20000000-0000-4000-8000-000000000016';
const observerStation = '40000000-0000-4000-8000-000000000010';

describe('Authoritative service workflows', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
      insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Cena',true);
      insert into public.zones(id,venue_id,room_id,name) values('${zone}','${ids.venue}','${room}','Interno');
      insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}','${zone}',1,'Tavolo 1',4);
      insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Cucina');
      insert into public.table_assignments(venue_id,waiter_id,mode,zone_id) values('${ids.venue}','${ids.waiter}','ZONE','${zone}');
      insert into public.categories(id,name) values('${category}','Primi');
      insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','Piatto test',1800);
      insert into public.ingredients(id,name) values('${ingredient}','Pecorino');
      insert into public.allergens(id,code,name) values('${allergen}','MILK','Latte');
      insert into public.ingredient_allergens values('${ingredient}','${allergen}');
      insert into public.dish_ingredients values('${dish}','${ingredient}',false);
      insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
        values('${ids.venue}','${dish}',1,(now() at time zone 'Europe/Rome')::date,'${station}');
      insert into public.dish_station_assignments values('${ids.venue}','${dish}','${station}',true);
      insert into public.cash_registers(id,venue_id,name,code,status) values('${register}','${ids.venue}','Reception','R1','OPEN');
      insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
      insert into auth.users(id) values('${cook}'),('${observer}'),('${pass}'),('${customer}'),('${customer2}'),('${tableWaiter}'),('${runner}'),('${kitchenAdmin}');
      insert into public.staff_profiles(id,display_name,role,scope) values('${cook}','Cuoco','KITCHEN_STAFF','VENUE'),('${observer}','Osservatore','KITCHEN_STAFF','VENUE'),('${pass}','Pass','PASS','VENUE'),('${tableWaiter}','Cameriere tavolo','WAITER','VENUE'),('${runner}','Runner','WAITER','VENUE'),('${kitchenAdmin}','Responsabile cucina','KITCHEN_ADMIN','VENUE');
      insert into public.staff_venue_assignments(user_id,venue_id) values('${cook}','${ids.venue}'),('${observer}','${ids.venue}'),('${pass}','${ids.venue}'),('${tableWaiter}','${ids.venue}'),('${runner}','${ids.venue}'),('${kitchenAdmin}','${ids.venue}');
      insert into auth.sessions(id,user_id) values('${sessionId(cook)}','${cook}'),('${sessionId(observer)}','${observer}'),('${sessionId(pass)}','${pass}'),('${sessionId(customer)}','${customer}'),('${sessionId(customer2)}','${customer2}'),('${sessionId(tableWaiter)}','${tableWaiter}'),('${sessionId(runner)}','${runner}'),('${sessionId(kitchenAdmin)}','${kitchenAdmin}');
      insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until) select id,user_id,now(),now()+interval '2 hours' from auth.sessions where user_id in ('${cook}','${observer}','${pass}','${tableWaiter}','${runner}','${kitchenAdmin}');
      insert into public.stations(id,venue_id,name) values('${observerStation}','${ids.venue}','Osservatrice');
      insert into public.dish_station_assignments values('${ids.venue}','${dish}','${observerStation}',false);
      insert into public.station_staff_assignments values('${ids.venue}','${station}','${cook}',true),('${ids.venue}','${observerStation}','${observer}',true);
    `);
  });
  beforeEach(async () => {
    await db.exec('begin');
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  async function createAccount() {
    await identity(db, ids.waiter);
    const response = await db.query<{ result: { id: string; code: string } }>(
      `select public.create_account($1,'Rossi',2,null,$2) as result`,
      [table, accountKey],
    );
    const result = response.rows[0]?.result;
    if (!result) throw new Error('Missing account result');
    return result;
  }

  it('publishes only INSERT invalidations and protects account and station signals with RLS', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    expect(
      (
        await db.query(
          "select pubinsert,pubupdate,pubdelete,pubtruncate from pg_publication where pubname='supabase_realtime'",
        )
      ).rows,
    ).toEqual([{ pubinsert: true, pubupdate: false, pubdelete: false, pubtruncate: false }]);
    expect(
      (
        await db.query(
          "select tablename from pg_publication_tables where pubname='supabase_realtime'",
        )
      ).rows,
    ).toEqual([{ tablename: 'realtime_signals' }]);
    await identity(db, observer);
    expect(
      (
        await db.query<{ total: number }>(
          "select count(*)::integer as total from public.realtime_signals where topic='KITCHEN'",
        )
      ).rows[0]!.total,
    ).toBeGreaterThan(0);
    expect(
      (
        await db.query(
          "select id from public.realtime_signals where topic in ('ACCOUNT','FINANCE','BOOKING')",
        )
      ).rows,
    ).toHaveLength(0);
    await identity(db, ids.host);
    expect(
      (
        await db.query(
          "select id from public.realtime_signals where topic in ('ACCOUNT','FINANCE','KITCHEN')",
        )
      ).rows,
    ).toHaveLength(0);
    await identity(db, ids.superAdmin);
    expect(
      (
        await db.query(
          "select id from public.realtime_signals where topic in ('ACCOUNT','FINANCE','KITCHEN','BOOKING')",
        )
      ).rows,
    ).toHaveLength(0);
    await db.exec('set role anon');
    expect((await db.query('select distinct topic from public.realtime_signals')).rows).toEqual([
      { topic: 'PUBLIC' },
    ]);
  });
  it('does not let authenticated clients forge realtime events', async () => {
    await identity(db, ids.waiter);
    await expect(
      db.query("insert into public.realtime_signals(topic,venue_id) values('FLOOR',$1)", [
        ids.venue,
      ]),
    ).rejects.toThrow('permission denied');
  });

  it('invalidates kitchen and assigned station snapshots when station routing changes', async () => {
    const account = await createAccount();
    const placed = await submit(account.id);
    const order = placed.rows[0]?.result.id;
    if (!order) throw new Error('Missing order');
    await db.exec('reset role; delete from public.realtime_signals');
    await db.query("update public.stations set name='Cucina aggiornata' where id=$1", [station]);
    expect(
      (
        await db.query(
          "select topic,resource_id,recipient_user_id from public.realtime_signals where topic in ('CONFIG','ACCESS','KITCHEN') order by topic,recipient_user_id nulls first",
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: 'CONFIG', resource_id: station }),
        expect.objectContaining({ topic: 'ACCESS', recipient_user_id: cook }),
        expect.objectContaining({ topic: 'KITCHEN', resource_id: order }),
      ]),
    );
    await db.exec('delete from public.realtime_signals');
    await db.query(
      'delete from public.dish_station_assignments where venue_id=$1 and dish_id=$2 and station_id=$3',
      [ids.venue, dish, observerStation],
    );
    expect(
      (
        await db.query(
          "select topic,resource_id,recipient_user_id from public.realtime_signals where topic in ('CONFIG','ACCESS','KITCHEN')",
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: 'CONFIG', resource_id: dish }),
        expect.objectContaining({ topic: 'ACCESS', recipient_user_id: observer }),
        expect.objectContaining({ topic: 'KITCHEN', resource_id: order }),
      ]),
    );
  });

  it('routes table assignments ahead of zones and keeps runners delivery-only', async () => {
    await identity(db, ids.admin);
    await db.query("select public.assign_waiter($1,$2,'TABLE',$3,null)", [
      ids.venue,
      tableWaiter,
      table,
    ]);
    expect(
      (await db.query('select private.responsible_waiter($1) waiter', [table])).rows[0],
    ).toEqual({
      waiter: tableWaiter,
    });
    await db.query("select public.assign_waiter($1,$2,'RUNNER',null,null)", [ids.venue, runner]);
    expect(
      (await db.query('select private.responsible_waiter($1) waiter', [table])).rows[0],
    ).toEqual({
      waiter: tableWaiter,
    });
    expect(
      (
        await db.query(
          'select mode,table_id,zone_id from public.table_assignments where waiter_id=$1 and active',
          [runner],
        )
      ).rows,
    ).toEqual([{ mode: 'RUNNER', table_id: null, zone_id: null }]);
  });

  async function attachCustomer(account: { id: string; code: string }, user = customer) {
    await db.exec('reset role');
    const publicId = (
      await db.query<{ id: string }>(
        'select public_table_id as id from public.tables where id=$1',
        [table],
      )
    ).rows[0]?.id;
    if (!publicId) throw new Error('Missing public table id');
    const verified = (
      await db.query<{
        result: { account_id: string; table_id: string; access_epoch: number };
      }>('select public.verify_customer_code($1,$2) as result', [publicId, account.code])
    ).rows[0]?.result;
    if (!verified) throw new Error('Missing customer verification');
    await db.query('select public.attach_customer_session($1,$2,$3,$4)', [
      user,
      verified.account_id,
      verified.table_id,
      verified.access_epoch,
    ]);
    await identity(db, user);
    return publicId;
  }

  it('applies progressive customer-code backoff, bounds stale buckets and clears success', async () => {
    await db.exec('reset role');
    const bucket = 'a'.repeat(64);
    const stale = 'b'.repeat(64);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.record_customer_access_failure($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBe(0);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.record_customer_access_failure($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBe(0);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.record_customer_access_failure($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBe(0);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.record_customer_access_failure($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.check_customer_access_backoff($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBeGreaterThan(0);
    await db.query(
      "insert into private.customer_access_backoff(bucket,failures,last_attempt_at) values($1,1,now()-interval '2 days')",
      [stale],
    );
    await db.query('select public.record_customer_access_failure($1)', ['c'.repeat(64)]);
    expect(
      (
        await db.query<{ total: number }>(
          'select count(*)::integer total from private.customer_access_backoff where bucket=$1',
          [stale],
        )
      ).rows[0]?.total,
    ).toBe(0);
    await db.query('select public.clear_customer_access_backoff($1)', [bucket]);
    expect(
      (
        await db.query<{ seconds: number }>(
          'select public.check_customer_access_backoff($1) seconds',
          [bucket],
        )
      ).rows[0]?.seconds,
    ).toBe(0);
  });

  it('keeps the permanent QR public_table_id immutable at database level', async () => {
    await db.exec('reset role');
    const before = (
      await db.query<{ public_table_id: string }>(
        'select public_table_id from public.tables where id=$1',
        [table],
      )
    ).rows[0]!.public_table_id;
    await db.exec('savepoint before_qr_identity_violation');
    await expect(
      db.query('update public.tables set public_table_id=gen_random_uuid() where id=$1', [table]),
    ).rejects.toThrow('PUBLIC_TABLE_ID_IMMUTABLE');
    await db.exec('rollback to savepoint before_qr_identity_violation');
    expect(
      (
        await db.query<{ public_table_id: string }>(
          'select public_table_id from public.tables where id=$1',
          [table],
        )
      ).rows[0]!.public_table_id,
    ).toBe(before);
  });

  it('allows multiple isolated customer sessions on the same account', async () => {
    const account = await createAccount();
    const publicId = await attachCustomer(account, customer);
    expect(
      (
        await db.query<{ result: { id: string } }>(
          'select public.get_customer_account($1) result',
          [publicId],
        )
      ).rows[0]?.result.id,
    ).toBe(account.id);
    await db.exec('reset role');
    await attachCustomer(account, customer2);
    expect(
      (
        await db.query<{ result: { id: string } }>(
          'select public.get_customer_account($1) result',
          [publicId],
        )
      ).rows[0]?.result.id,
    ).toBe(account.id);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ total: number }>(
          'select count(*)::integer total from private.customer_sessions where account_id=$1 and revoked_at is null',
          [account.id],
        )
      ).rows[0]?.total,
    ).toBe(2);
  });

  it('routes customer calls to the TABLE waiter and records acceptance and completion timing', async () => {
    // Create the account while its original zone waiter is responsible.
    // Reassign the table before the customer calls.
    const account = await createAccount();
    await identity(db, ids.admin);
    await db.query("select public.assign_waiter($1,$2,'TABLE',$3,null)", [
      ids.venue,
      tableWaiter,
      table,
    ]);
    await attachCustomer(account);
    const call = (
      await db.query<{ id: string }>("select public.call_waiter($1,'WAITER') id", [account.id])
    ).rows[0]?.id;
    if (!call) throw new Error('Missing waiter call');
    await db.exec('reset role');
    expect(
      (
        await db.query('select assigned_waiter_id,status from public.waiter_calls where id=$1', [
          call,
        ])
      ).rows[0],
    ).toEqual({ assigned_waiter_id: tableWaiter, status: 'NEW' });
    await identity(db, tableWaiter);
    await db.query('select public.transition_waiter_call($1,false)', [call]);
    await db.query('select public.transition_waiter_call($1,true)', [call]);
    expect(
      (
        await db.query(
          'select status,accepted_at is not null accepted,completed_at is not null completed,response_time is not null response from public.waiter_calls where id=$1',
          [call],
        )
      ).rows[0],
    ).toEqual({ status: 'COMPLETED', accepted: true, completed: true, response: true });
    expect(
      (
        await db.query(
          "select status from public.notifications where resource_type='waiter_calls' and resource_id=$1",
          [call],
        )
      ).rows[0],
    ).toEqual({ status: 'RESOLVED' });
  });

  it('supports WAITER_APPROVAL with a waiter workspace and resolves the persistent notification', async () => {
    const account = await createAccount();
    await db.exec(
      "reset role; update public.feature_flags set licensed=true where name='CLIENT_ORDERING'; update public.venue_settings set customer_ordering='WAITER_APPROVAL' where venue_id='" +
        ids.venue +
        "'",
    );
    await attachCustomer(account);
    const requested = (
      await db.query<{ result: { request_id: string; status: string } }>(
        'select public.create_customer_order_request($1,$2,$3) result',
        [
          account.id,
          JSON.stringify([
            { dish_id: dish, quantity: 1, step: 1, removed_ingredients: [], variant_options: [] },
          ]),
          crypto.randomUUID(),
        ],
      )
    ).rows[0]?.result;
    expect(requested?.status).toBe('PENDING');
    await db.exec('reset role');
    await identity(db, ids.waiter);
    const workspace = (
      await db.query<{
        result: { id: string; account_name: string; items: { name: string; quantity: number }[] }[];
      }>('select public.get_customer_order_approval_workspace($1) result', [ids.venue])
    ).rows[0]?.result;
    expect(workspace).toEqual([
      expect.objectContaining({
        id: requested?.request_id,
        account_name: 'Rossi',
        items: [expect.objectContaining({ name: 'Piatto test', quantity: 1 })],
      }),
    ]);
    const resolved = (
      await db.query<{ result: { status: string; order_id: string } }>(
        'select public.resolve_customer_order($1,true,null) result',
        [requested?.request_id],
      )
    ).rows[0]?.result;
    expect(resolved?.status).toBe('APPROVED');
    expect(resolved?.order_id).toBeTruthy();
    expect(
      (
        await db.query(
          "select status from public.notifications where resource_type='customer_order_requests' and resource_id=$1",
          [requested?.request_id],
        )
      ).rows,
    ).toEqual([{ status: 'RESOLVED' }]);
  });

  it('supports DIRECT ordering and rejects ordering when the mode is DISABLED', async () => {
    const account = await createAccount();
    await db.exec(
      "reset role; update public.feature_flags set licensed=true where name='CLIENT_ORDERING'; update public.venue_settings set customer_ordering='DIRECT' where venue_id='" +
        ids.venue +
        "'",
    );
    await attachCustomer(account);
    const direct = (
      await db.query<{ result: { status: string; order_id: string } }>(
        'select public.create_customer_order_request($1,$2,$3) result',
        [
          account.id,
          JSON.stringify([
            { dish_id: dish, quantity: 1, step: 1, removed_ingredients: [], variant_options: [] },
          ]),
          crypto.randomUUID(),
        ],
      )
    ).rows[0]?.result;
    expect(direct?.status).toBe('APPROVED');
    expect(direct?.order_id).toBeTruthy();
    await db.exec('reset role');
    await db.exec(
      "update public.venue_settings set customer_ordering='DISABLED' where venue_id='" +
        ids.venue +
        "'; update public.venue_dish_settings set availability=1 where venue_id='" +
        ids.venue +
        "' and dish_id='" +
        dish +
        "'",
    );
    await identity(db, customer);
    await expect(
      db.query('select public.create_customer_order_request($1,$2,$3)', [
        account.id,
        JSON.stringify([
          { dish_id: dish, quantity: 1, step: 1, removed_ingredients: [], variant_options: [] },
        ]),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('ORDERING_DISABLED');
  });

  it('moves accounts and customer sessions while preserving the code and denying the old QR', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    const target = '40000000-0000-4000-8000-000000000020';
    await db.query(
      `insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values($1,$2,$3,$4,2,'Destinazione',4)`,
      [target, ids.venue, room, layout],
    );
    const oldQr = (
      await db.query<{ public_table_id: string }>(
        'select public_table_id from public.tables where id=$1',
        [table],
      )
    ).rows[0]!.public_table_id;
    const newQr = (
      await db.query<{ public_table_id: string }>(
        'select public_table_id from public.tables where id=$1',
        [target],
      )
    ).rows[0]!.public_table_id;
    const epoch = (
      await db.query<{ access_epoch: number }>(
        'select access_epoch from public.accounts where id=$1',
        [account.id],
      )
    ).rows[0]!.access_epoch;
    await db.query('select public.attach_customer_session($1,$2,$3,$4)', [
      customer,
      account.id,
      table,
      epoch,
    ]);
    await identity(db, ids.host);
    await db.query('select public.move_table($1,$2,true)', [table, target]);
    await identity(db, customer);
    const moved = (
      await db.query<{ result: { id: string; items: unknown[] } }>(
        'select public.get_customer_account($1) as result',
        [newQr],
      )
    ).rows[0]!.result;
    expect(moved.id).toBe(account.id);
    expect(moved.items).toHaveLength(1);
    await db.exec('savepoint old_qr');
    await expect(db.query('select public.get_customer_account($1)', [oldQr])).rejects.toThrow(
      'CUSTOMER_SESSION_REQUIRED',
    );
    await db.exec('rollback to savepoint old_qr; reset role; set role service_role');
    expect(
      (await db.query('select public.verify_customer_code($1,$2) as result', [oldQr, account.code]))
        .rows[0],
    ).toEqual({ result: null });
    expect(
      (await db.query('select public.verify_customer_code($1,$2) as result', [newQr, account.code]))
        .rows[0],
    ).toMatchObject({ result: { account_id: account.id, table_id: target } });
    await identity(db, ids.waiter);
    expect(
      (await db.query('select private.responsible_waiter($1) as waiter', [target])).rows[0],
    ).toEqual({ waiter: ids.waiter });
  });

  async function submit(account: string, key = orderKey, overrides = {}) {
    const state = await db.query<{ version: number }>(
      'select version from public.accounts where id=$1',
      [account],
    );
    return db.query<{ result: { id: string } }>(
      'select public.create_order($1,$2,$3,$4) as result',
      [
        account,
        JSON.stringify([{ dish_id: dish, quantity: 1, step: 1, ...overrides }]),
        key,
        state.rows[0]?.version,
      ],
    );
  }

  it('allows a responsible waiter to create an account, hashing the six-digit code', async () => {
    const account = await createAccount();
    expect(account.code).toMatch(/^\d{6}$/);
    await db.exec('reset role');
    const result = await db.query<{ valid: boolean; stored: string }>(
      `select extensions.crypt($1,code_hash)=code_hash as valid,code_hash as stored from private.customer_access_codes where account_id=$2`,
      [account.code, account.id],
    );
    expect(result.rows[0]?.valid).toBe(true);
    expect(result.rows[0]?.stored).not.toBe(account.code);
    const retry = await db.query<{ response: { code?: string } }>(
      'select response from private.idempotency_keys where key=$1',
      [accountKey],
    );
    expect(retry.rows[0]?.response).not.toHaveProperty('code');
  });

  it('denies Host account creation through RPC even though Host can read the table', async () => {
    await identity(db, ids.host);
    expect((await db.query('select id from public.tables')).rows).toHaveLength(1);
    await expect(
      db.query(`select public.create_account($1,'Forbidden',2,null,$2)`, [table, accountKey]),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('prices from the catalog, consumes stock and emits business audit atomically', async () => {
    const account = await createAccount();
    await submit(account.id);
    expect(
      (await db.query('select quantity,unit_price_cents,allergen_snapshot from public.order_items'))
        .rows,
    ).toEqual([
      { quantity: 1, unit_price_cents: 1800, allergen_snapshot: [{ code: 'MILK', name: 'Latte' }] },
    ]);
    expect((await db.query('select availability from public.venue_dish_settings')).rows).toEqual([
      { availability: 0 },
    ]);
    await db.exec('reset role');
    expect(
      (await db.query(`select id from public.audit_log where action='ORDER_ITEMS_INSERT'`)).rows,
    ).toHaveLength(1);
  });

  it('rejects a forged price rather than accepting a client economic value', async () => {
    const account = await createAccount();
    await expect(submit(account.id, orderKey, { unit_price_cents: 1 })).rejects.toThrow(
      'INVALID_ITEM_FIELDS',
    );
  });

  it('rolls back the entire order when two lines compete for the last portion', async () => {
    const account = await createAccount();
    const state = await db.query<{ version: number }>(
      'select version from public.accounts where id=$1',
      [account.id],
    );
    await db.exec('savepoint before_order');
    await expect(
      db.query('select public.create_order($1,$2,$3,$4)', [
        account.id,
        JSON.stringify([
          { dish_id: dish, quantity: 1, step: 1 },
          { dish_id: dish, quantity: 1, step: 2 },
        ]),
        orderKey,
        state.rows[0]?.version,
      ]),
    ).rejects.toThrow('OUT_OF_STOCK');
    await db.exec('rollback to savepoint before_order');
    expect((await db.query('select id from public.orders')).rows).toEqual([]);
    expect((await db.query('select availability from public.venue_dish_settings')).rows).toEqual([
      { availability: 1 },
    ]);
  });

  it('replays a committed order with the same key without consuming stock twice', async () => {
    const account = await createAccount();
    const state = await db.query<{ version: number }>(
      'select version from public.accounts where id=$1',
      [account.id],
    );
    const args = [
      account.id,
      JSON.stringify([{ dish_id: dish, quantity: 1, step: 1 }]),
      orderKey,
      state.rows[0]?.version,
    ];
    const first = await db.query('select public.create_order($1,$2,$3,$4) as result', args);
    const second = await db.query('select public.create_order($1,$2,$3,$4) as result', args);
    expect(second.rows).toEqual(first.rows);
    expect((await db.query('select id from public.orders')).rows).toHaveLength(1);
  });

  it('keeps historical price when the current menu price changes', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await db.exec(`update public.dishes set price_cents=2000 where id='${dish}'`);
    expect((await db.query('select unit_price_cents from public.order_items')).rows).toEqual([
      { unit_price_cents: 1800 },
    ]);
  });

  it('sends waiter modification and cancellation requests through an Admin decision', async () => {
    const account = await createAccount();
    const placed = await submit(account.id);
    const order = placed.rows[0]?.result.id;
    if (!order) throw new Error('Missing order');
    const state = (
      await db.query<{ id: string; version: number }>(
        'select id,version from public.orders where id=$1',
        [order],
      )
    ).rows[0]!;
    const item = (
      await db.query<{ id: string }>('select id from public.order_items where order_id=$1', [order])
    ).rows[0]!.id;
    const payload = JSON.stringify({ item_ids: [item], replacement_lines: [] });
    const modification = (
      await db.query<{ result: { id: string; status: string } }>(
        "select public.request_order_change($1,'MODIFICATION',$2,$3,$4,$5) result",
        [order, payload, 'Cliente cambia idea', state.version, crypto.randomUUID()],
      )
    ).rows[0]!.result;
    expect(modification.status).toBe('PENDING');
    await db.exec('reset role');
    await identity(db, ids.admin);
    await db.query("select public.resolve_order_change($1,false,'Modifica non confermata',$2)", [
      modification.id,
      crypto.randomUUID(),
    ]);
    expect(
      (
        await db.query('select status from public.order_change_requests where id=$1', [
          modification.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'REJECTED' });
    expect(
      (await db.query('select status from public.order_items where id=$1', [item])).rows[0],
    ).toEqual({
      status: 'RECEIVED',
    });

    await db.exec('reset role');
    await identity(db, ids.waiter);
    const cancellation = (
      await db.query<{ result: { id: string; status: string } }>(
        "select public.request_order_change($1,'CANCELLATION',$2,$3,$4,$5) result",
        [order, payload, 'Cliente annulla il piatto', state.version, crypto.randomUUID()],
      )
    ).rows[0]!.result;
    await db.exec('reset role');
    await identity(db, ids.admin);
    await db.query("select public.resolve_order_change($1,true,'Annullamento verificato',$2)", [
      cancellation.id,
      crypto.randomUUID(),
    ]);
    expect(
      (
        await db.query('select status from public.order_change_requests where id=$1', [
          cancellation.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'APPROVED' });
    expect(
      (await db.query('select status from public.order_items where id=$1', [item])).rows[0],
    ).toEqual({
      status: 'CANCELLED',
    });
    expect((await db.query('select availability from public.venue_dish_settings')).rows).toEqual([
      { availability: 1 },
    ]);
  });

  it('does not expose account data to Host or to the technical Super Admin', async () => {
    await createAccount();
    await db.exec('reset role');
    await identity(db, ids.host);
    expect((await db.query('select id from public.accounts')).rows).toEqual([]);
    await db.exec('reset role');
    await identity(db, ids.superAdmin);
    expect((await db.query('select id from public.accounts')).rows).toEqual([]);
    expect((await db.query('select id from public.audit_log limit 1')).rows).toHaveLength(1);
  });

  it('returns an anonymous menu with inherited allergens and no operational fields', async () => {
    await db.exec('set role anon');
    const result = await db.query<{ menu: Record<string, unknown>[] }>(
      'select public.get_public_menu($1) as menu',
      [ids.venue],
    );
    expect(result.rows[0]?.menu[0]).toMatchObject({
      name: 'Piatto test',
      price_cents: 1800,
      allergens: [{ code: 'MILK', name: 'Latte' }],
    });
    expect(result.rows[0]?.menu[0]).not.toHaveProperty('station_id');
  });

  async function payableAccount() {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await identity(db, ids.cashier);
    await db.query('select public.open_service_session($1,null,$2,30000,$3)', [
      ids.venue,
      register,
      serviceKey,
    ]);
    return account.id;
  }

  it('routes preparation to the primary station, coordinates Pass, then delivers', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await identity(db, cook);
    type Ticket = { id: string; step_id: string; version: number; status: string };
    const board = await db.query<{ board: Ticket[] }>(
      'select public.get_kitchen_board($1) as board',
      [ids.venue],
    );
    const item = board.rows[0]?.board[0];
    if (!item) throw new Error('Missing kitchen ticket');
    expect(item).not.toHaveProperty('unit_price_cents');
    expect((await db.query('select id from public.order_items')).rows).toEqual([]);
    await db.query("select public.transition_order_item($1,'IN_PREPARATION',$2)", [
      item.id,
      item.version,
    ]);
    await db.query("select public.transition_order_item($1,'READY',$2)", [
      item.id,
      item.version + 1,
    ]);
    await db.exec('reset role');
    await identity(db, pass);
    await db.query('select public.mark_step_ready($1)', [item.step_id]);
    await db.exec('reset role');
    await identity(db, ids.waiter);
    await db.query('select public.deliver_step($1,false)', [item.step_id]);
    const ownPickup = await db.query<{ step_id: string; served_at: string | null }>(
      'select step_id, served_at from public.step_deliveries where step_id=$1 and waiter_id=$2',
      [item.step_id, ids.waiter],
    );
    expect(ownPickup.rows).toEqual([{ step_id: item.step_id, served_at: null }]);
    await db.query('select public.deliver_step($1,true)', [item.step_id]);
    expect((await db.query('select status from public.orders')).rows).toEqual([
      { status: 'SERVED' },
    ]);
  });

  it('lets an assigned runner claim and serve a ready step without becoming the responsible waiter', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await identity(db, ids.admin);
    await db.query("select public.assign_waiter($1,$2,'RUNNER',null,null)", [ids.venue, runner]);
    await db.exec('reset role');
    await identity(db, cook);
    const board = (
      await db.query<{ board: { id: string; step_id: string; version: number }[] }>(
        'select public.get_kitchen_board($1) as board',
        [ids.venue],
      )
    ).rows[0]!.board;
    const item = board[0]!;
    await db.query("select public.transition_order_item($1,'IN_PREPARATION',$2)", [
      item.id,
      item.version,
    ]);
    await db.query("select public.transition_order_item($1,'READY',$2)", [
      item.id,
      item.version + 1,
    ]);
    await db.exec('reset role');
    await identity(db, pass);
    await db.query('select public.mark_step_ready($1)', [item.step_id]);
    await db.exec('reset role');
    await identity(db, runner);
    const runnerBoard = (
      await db.query<{ board: { step_id: string; can_deliver: boolean }[] }>(
        'select public.get_kitchen_board($1) as board',
        [ids.venue],
      )
    ).rows[0]!.board;
    expect(runnerBoard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step_id: item.step_id, can_deliver: true }),
      ]),
    );
    await db.query('select public.deliver_step($1,false)', [item.step_id]);
    const runnerPickup = await db.query<{ step_id: string; served_at: string | null }>(
      'select step_id, served_at from public.step_deliveries where step_id=$1 and waiter_id=$2',
      [item.step_id, runner],
    );
    expect(runnerPickup.rows).toEqual([{ step_id: item.step_id, served_at: null }]);
    await db.query('select public.deliver_step($1,true)', [item.step_id]);
    // The Runner can deliver this step but cannot read orders directly.
    expect((await db.query('select status from public.orders')).rows).toEqual([]);
    await db.exec('reset role');
    expect((await db.query('select status from public.orders')).rows).toEqual([
      { status: 'SERVED' },
    ]);
  });

  it('gives observing stations visibility without permission to change preparation', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await identity(db, observer);
    const board = await db.query<{
      board: { id: string; version: number; can_prepare: boolean }[];
    }>('select public.get_kitchen_board($1) as board', [ids.venue]);
    const item = board.rows[0]?.board[0];
    if (!item) throw new Error('Missing observer ticket');
    expect(item.can_prepare).toBe(false);
    await expect(
      db.query("select public.transition_order_item($1,'IN_PREPARATION',$2)", [
        item.id,
        item.version,
      ]),
    ).rejects.toThrow('PRIMARY_STATION_REQUIRED');
  });

  it('lets KITCHEN_ADMIN supervise every station without a station assignment', async () => {
    const account = await createAccount();
    await submit(account.id);
    await db.exec('reset role');
    await identity(db, kitchenAdmin);
    expect(
      (await db.query('select private.can_work_station($1,$2) allowed', [ids.venue, station]))
        .rows[0],
    ).toEqual({ allowed: true });
    expect(
      (
        await db.query('select private.can_work_station($1,$2) allowed', [
          ids.venue,
          observerStation,
        ])
      ).rows[0],
    ).toEqual({ allowed: true });
    const board = (
      await db.query<{ board: { id: string; version: number; can_prepare: boolean }[] }>(
        'select public.get_kitchen_board($1) as board',
        [ids.venue],
      )
    ).rows[0]!.board;
    expect(board[0]?.can_prepare).toBe(true);
  });

  it('isolates a customer account and invalidates the session when its code rotates', async () => {
    const account = await createAccount();
    await submit(account.id);
    const other = await db.query<{ result: { id: string } }>(
      "select public.create_account($1,'Altro conto',2,null,$2) as result",
      [table, crypto.randomUUID()],
    );
    await db.exec('reset role');
    const publicId = (
      await db.query<{ id: string }>(
        'select public_table_id as id from public.tables where id=$1',
        [table],
      )
    ).rows[0]?.id;
    const verification = await db.query<{
      result: { account_id: string; table_id: string; access_epoch: number };
    }>('select public.verify_customer_code($1,$2) as result', [publicId, account.code]);
    const verified = verification.rows[0]?.result;
    if (!verified) throw new Error('Missing code verification');
    await db.query('select public.attach_customer_session($1,$2,$3,$4)', [
      customer,
      verified.account_id,
      verified.table_id,
      verified.access_epoch,
    ]);
    await identity(db, customer);
    const projection = await db.query<{ result: Record<string, unknown> }>(
      'select public.get_customer_account($1) as result',
      [publicId],
    );
    expect(projection.rows[0]?.result).toMatchObject({ id: account.id, name: 'Rossi' });
    expect(projection.rows[0]?.result).not.toHaveProperty('internal_note');
    expect((await db.query('select id from public.accounts')).rows).toEqual([]);
    await db.exec('savepoint other_account');
    await expect(
      db.query('select public.get_account_balance($1)', [other.rows[0]?.result.id]),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint other_account; reset role');
    await identity(db, ids.waiter);
    await db.query('select public.regenerate_account_code($1)', [account.id]);
    await db.exec('reset role');
    await identity(db, customer);
    await expect(db.query('select public.get_customer_account($1)', [publicId])).rejects.toThrow(
      'CUSTOMER_SESSION_REQUIRED',
    );
  });

  async function payment(account: string, amount: number, key = paymentKey, tip = 0) {
    const result = await db.query<{ result: { id: string; status: string } }>(
      "select public.create_payment($1,$2,$3,$4,'CASH',$5) as result",
      [account, register, amount, tip, key],
    );
    const value = result.rows[0]?.result;
    if (!value) throw new Error('Missing payment result');
    return value;
  }

  it('reserves pending payments and prevents a second payment consuming the same balance', async () => {
    const account = await payableAccount();
    await payment(account, 1800);
    await expect(payment(account, 1800, crypto.randomUUID())).rejects.toThrow(
      'INVALID_PAYMENT_AMOUNT',
    );
  });

  it('recovers a pending payment after loss of its response with the same idempotency key', async () => {
    const account = await payableAccount();
    const first = await payment(account, 1800);
    expect(await payment(account, 1800)).toEqual(first);
    expect((await db.query('select id from public.payments')).rows).toHaveLength(1);
    await expect(payment(account, 1)).rejects.toThrow('IDEMPOTENCY_MISMATCH');
  });

  it('records revenue and tips separately, closes only a fully settled account and invalidates the code', async () => {
    const account = await payableAccount();
    const pending = await payment(account, 1800, paymentKey, 200);
    await db.query('select public.confirm_manual_payment($1,true)', [pending.id]);
    expect(
      (await db.query('select amount_cents,tip_cents,status from public.payments')).rows,
    ).toEqual([{ amount_cents: 1800, tip_cents: 200, status: 'COMPLETED' }]);
    expect((await db.query('select amount_cents from public.tips')).rows).toEqual([
      { amount_cents: 200 },
    ]);
    await db.query('select public.close_account($1)', [account]);
    expect((await db.query('select status from public.accounts')).rows).toEqual([
      { status: 'CLOSED' },
    ]);
    await db.exec('reset role');
    expect((await db.query('select account_id from private.customer_access_codes')).rows).toEqual(
      [],
    );
    expect((await db.query('select technical_status from public.tables')).rows).toEqual([
      // Financial closure leaves an unfinished meal in service until delivery.
      { technical_status: 'WAITING_SERVICE' },
    ]);
  });

  it('does not allow closing a partially paid account', async () => {
    const account = await payableAccount();
    const pending = await payment(account, 1000);
    await db.query('select public.confirm_manual_payment($1,true)', [pending.id]);
    expect((await db.query('select status from public.accounts')).rows).toEqual([
      { status: 'PARTIALLY_PAID' },
    ]);
    await expect(db.query('select public.close_account($1)', [account])).rejects.toThrow(
      'ACCOUNT_NOT_SETTLED',
    );
  });

  it('denies direct payment status updates and refund without an Admin password grant', async () => {
    const account = await payableAccount();
    const pending = await payment(account, 1800);
    await db.query('select public.confirm_manual_payment($1,true)', [pending.id]);
    await db.exec('reset role');
    await identity(db, ids.admin);
    await db.exec('savepoint before_status');
    await expect(db.exec("update public.payments set status='REFUNDED'")).rejects.toThrow();
    await db.exec('rollback to savepoint before_status');
    await expect(
      db.query("select public.create_refund($1,1800,0,'Rimborso test',null,$2)", [
        pending.id,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('STEP_UP_REQUIRED');
  });
});
