import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';
const room = 'c0000000-0000-4000-8000-000000000001',
  layout = 'c0000000-0000-4000-8000-000000000002',
  table = 'c0000000-0000-4000-8000-000000000003',
  station = 'c0000000-0000-4000-8000-000000000004',
  category = 'c0000000-0000-4000-8000-000000000005',
  dish = 'c0000000-0000-4000-8000-000000000006',
  register = 'c0000000-0000-4000-8000-000000000008';
describe('completion: authoritative catalog, editor, planning and equal shares', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
    update public.staff_profiles set scope='CHAIN' where id='${ids.admin}';
    insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala');
    insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Cena',true);
    insert into public.tables(id,venue_id,room_id,layout_id,name,number,seats) values('${table}','${ids.venue}','${room}','${layout}','Tavolo 1',1,6);
    insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','Bar');
    insert into public.categories(id,name) values('${category}','Bevande');
    insert into public.dishes(id,category_id,name,beverage,price_cents) values('${dish}','${category}','Bibita',true,1001);
    insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id) values('${ids.venue}','${dish}',5,(now() at time zone 'Europe/Rome')::date,'${station}');
    insert into public.table_assignments(venue_id,waiter_id,mode,table_id) values('${ids.venue}','${ids.waiter}','TABLE','${table}');
    insert into public.cash_registers(id,venue_id,name,code) values('${register}','${ids.venue}','Cassa','TEST');
    insert into public.cashier_assignments(venue_id,cash_register_id,user_id) values('${ids.venue}','${register}','${ids.cashier}');
  `);
  });
  beforeEach(async () => {
    await db.exec('reset role; begin;');
    await identity(db, ids.admin);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role;');
  });
  afterAll(async () => {
    await db?.close();
  });
  async function version(entity: string, id: string) {
    return (
      await db.query<{ version: number }>(`select version from public.${entity} where id=$1`, [id])
    ).rows[0]!.version;
  }
  async function createOrder() {
    await identity(db, ids.waiter);
    const a = (
      await db.query<{ r: { id: string } }>(
        "select public.create_account($1,'Gruppo',3,null,$2) r",
        [table, crypto.randomUUID()],
      )
    ).rows[0]!.r.id;
    const items = [
      { dish_id: dish, quantity: 3, step: 1, removed_ingredients: [], variant_options: [] },
    ];
    await db.query('select public.create_order($1,$2,$3,$4)', [
      a,
      JSON.stringify(items),
      crypto.randomUUID(),
      await version('accounts', a),
    ]);
    return a;
  }
  it('does not silently finish a truncated migration', async () => {
    expect(
      (
        await db.query<{ name: string }>(
          "select proname name from pg_proc where proname='create_payment'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('preserves exact cents and reserves each equal share once', async () => {
    const a = await createOrder();
    await identity(db, ids.cashier);
    await db.query('select public.set_cash_register_open($1,true)', [register]);
    await db.query('select public.open_service_session($1,null,$2,0,$3)', [
      ids.venue,
      register,
      crypto.randomUUID(),
    ]);
    const plan = (
      await db.query<{ r: { shares: { id: string; amount_cents: number }[] } }>(
        'select public.create_equal_split($1,2,$2,$3) r',
        [a, await version('accounts', a), crypto.randomUUID()],
      )
    ).rows[0]!.r;
    expect(plan.shares.map((s) => s.amount_cents)).toEqual([1502, 1501]);
    const key = crypto.randomUUID();
    const args = [a, register, 1, 0, key, plan.shares[0]!.id];
    const pay = () =>
      db.query<{ r: { id: string; amount_cents: number } }>(
        "select public.create_payment($1,$2,$3,$4,'CASH',$5,'[]',$6) r",
        args,
      );
    const first = (await pay()).rows[0]!.r;
    expect(first.amount_cents).toBe(1502);
    expect((await pay()).rows[0]!.r.id).toBe(first.id);
    await expect(
      db.query("select public.create_payment($1,$2,1,0,'CASH',$3,'[]',$4)", [
        a,
        register,
        crypto.randomUUID(),
        plan.shares[0]!.id,
      ]),
    ).rejects.toThrow('SHARE_ALREADY_PAID');
  });
  it('rejects a stale availability form after an order consumes stock', async () => {
    const old = (
      await db.query<{ version: number }>(
        'select version from public.venue_dish_settings where dish_id=$1',
        [dish],
      )
    ).rows[0]!.version;
    await createOrder();
    await identity(db, ids.admin);
    await expect(
      db.query("select public.save_venue_dish($1,$2,$3,true,null,5,$4,'{}',$5)", [
        ids.venue,
        dish,
        old,
        station,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('VERSION_CONFLICT');
  });
  it('enforces canonical temporary-dish schedules and blocks out-of-window orders', async () => {
    const current = await version('dishes', dish);
    await db.query(
      `select public.save_configuration_command(
        'dishes',null,$1,
        jsonb_build_object(
          'schedule_mode','DATE',
          'available_from',((now() at time zone 'Europe/Rome')::date+1)::text,
          'available_until',null,
          'weekdays',jsonb_build_array()
        ),$2,$3
      )`,
      [dish, current, crypto.randomUUID()],
    );
    await expect(createOrder()).rejects.toThrow('DISH_UNAVAILABLE');

    await db.exec('reset role');
    await expect(
      db.query(
        `update public.dishes
         set schedule_mode='ALWAYS', available_from=(now() at time zone 'Europe/Rome')::date
         where id=$1`,
        [dish],
      ),
    ).rejects.toThrow('dishes_schedule_consistency_check');
  });
  it('soft-archives menu entities so historic references remain but new orders are denied', async () => {
    const current = await version('dishes', dish);
    await db.query("select public.save_configuration_command('dishes',null,$1,$2::jsonb,$3,$4)", [
      dish,
      JSON.stringify({ active: false }),
      current,
      crypto.randomUUID(),
    ]);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ name: string; active: boolean }>(
          'select name,active from public.dishes where id=$1',
          [dish],
        )
      ).rows[0],
    ).toEqual({ name: 'Bibita', active: false });
    await expect(createOrder()).rejects.toThrow('DISH_UNAVAILABLE');
  });
  it('saves composition and archives removed options without breaking historic references', async () => {
    const v = await version('dishes', dish),
      group = crypto.randomUUID(),
      option = crypto.randomUUID();
    const variants = [
      {
        id: group,
        name: 'Temperatura',
        required: true,
        max_selections: 1,
        options: [{ id: option, label: 'Fredda' }],
      },
    ];
    const key = crypto.randomUUID();
    const args = [dish, v, JSON.stringify(variants), key];
    const save = () => db.query("select public.save_dish_composition($1,$2,'[]','{}',$3,$4)", args);
    await save();
    await save();
    const after = await version('dishes', dish);
    expect(after).toBeGreaterThan(v);
    await db.query("select public.save_dish_composition($1,$2,'[]','{}','[]',$3)", [
      dish,
      after,
      crypto.randomUUID(),
    ]);
    expect(
      (
        await db.query<{ active: boolean }>(
          'select active from public.variant_groups where id=$1',
          [group],
        )
      ).rows[0]!.active,
    ).toBe(false);
  });
  it('rejects cross-dish option hijacking', async () => {
    const other = crypto.randomUUID(),
      group = crypto.randomUUID(),
      opt = crypto.randomUUID();
    await db.exec('reset role');
    await db.query(
      "insert into public.dishes(id,category_id,name,beverage,price_cents) values($1,$2,'Altro',true,1)",
      [other, category],
    );
    await db.query("insert into public.variant_groups(id,dish_id,name) values($1,$2,'Altro')", [
      group,
      other,
    ]);
    await db.query("insert into public.variant_options(id,group_id,label) values($1,$2,'Altro')", [
      opt,
      group,
    ]);
    await identity(db, ids.admin);
    const variants = [
      {
        id: crypto.randomUUID(),
        name: 'Gruppo',
        required: false,
        max_selections: 1,
        options: [{ id: opt, label: 'Riusata' }],
      },
    ];
    await expect(
      db.query("select public.save_dish_composition($1,$2,'[]','{}',$3,$4)", [
        dish,
        await version('dishes', dish),
        JSON.stringify(variants),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('INVALID_VARIANTS');
  });
  it('enforces quotas on reactivation', async () => {
    await db.exec('reset role');
    await db.exec('update public.system_limits set max_dishes=1');
    const inactive = crypto.randomUUID();
    await db.query(
      "insert into public.dishes(id,category_id,name,price_cents,active) values($1,$2,'Archiviato',0,false)",
      [inactive, category],
    );
    await expect(
      db.query('update public.dishes set active=true where id=$1', [inactive]),
    ).rejects.toThrow('DISH_LIMIT');
  });
  it('serializes staff scheduling and rejects overlap', async () => {
    await db.query(
      "select public.save_shift_local($1,null,$2,'2026-10-12 18:00','2026-10-12 22:00',null,$3)",
      [ids.venue, ids.waiter, crypto.randomUUID()],
    );
    await expect(
      db.query(
        "select public.save_shift_local($1,null,$2,'2026-10-12 21:00','2026-10-12 23:00',null,$3)",
        [ids.venue, ids.waiter, crypto.randomUUID()],
      ),
    ).rejects.toThrow('SHIFT_OVERLAP');
  });
  it('rejects nonexistent times at the daylight-saving transition', async () => {
    await expect(
      db.query(
        "select public.save_shift_local($1,null,$2,'2027-03-28 02:30','2027-03-28 04:00',null,$3)",
        [ids.venue, ids.waiter, crypto.randomUUID()],
      ),
    ).rejects.toThrow('NONEXISTENT_LOCAL_TIME');
  });
  it('saves a layout atomically and retains permanent table QR identity', async () => {
    const before = (
      await db.query<{ public_table_id: string; version: number }>(
        'select public_table_id,version from public.tables where id=$1',
        [table],
      )
    ).rows[0]!;
    const data = [
      {
        id: table,
        version: before.version,
        name: 'Tavolo 1',
        number: 1,
        seats: 4,
        zone_id: null,
        shape: 'ROUND',
        position_x: 100,
        position_y: 80,
        width: 100,
        height: 100,
        rotation: 20,
      },
    ];
    const key = crypto.randomUUID(),
      args = [layout, await version('room_layouts', layout), JSON.stringify(data), key];
    const save = () => db.query("select public.save_room_layout($1,$2,'[]',$3,$4)", args);
    await save();
    await save();
    expect(
      (
        await db.query<{ public_table_id: string }>(
          'select public_table_id from public.tables where id=$1',
          [table],
        )
      ).rows[0]!.public_table_id,
    ).toBe(before.public_table_id);
    expect(
      (await db.query<{ count: number }>('select count(*)::int count from public.layout_revisions'))
        .rows[0]!.count,
    ).toBe(1);
  });
  it('blocks editor changes while a prepaid service still owns the table', async () => {
    await createOrder();
    await identity(db, ids.admin);
    await expect(
      db.query("select public.save_room_layout($1,$2,'[]','[]',$3)", [
        layout,
        await version('room_layouts', layout),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('LAYOUT_IN_SERVICE');
  });
  it('cannot delete or mutate layout history through the application role', async () => {
    await expect(db.exec('delete from public.layout_revisions')).rejects.toThrow();
  });
  it('cancels unstarted dishes with stock and cents updated atomically', async () => {
    const a = await createOrder();
    await identity(db, ids.admin);
    const o = (
      await db.query<{ id: string; version: number }>(
        'select id,version from public.orders where account_id=$1',
        [a],
      )
    ).rows[0]!;
    const i = (
      await db.query<{ id: string }>('select id from public.order_items where order_id=$1', [o.id])
    ).rows[0]!;
    await db.query("select public.modify_order($1,$2,$3,'[]','Errore confermato',$4)", [
      o.id,
      o.version,
      [i.id],
      crypto.randomUUID(),
    ]);
    expect(
      (
        await db.query<{ availability: number }>(
          'select availability from public.venue_dish_settings where dish_id=$1',
          [dish],
        )
      ).rows[0]!.availability,
    ).toBe(5);
    expect(
      (
        await db.query<{ r: { total_cents: number } }>('select public.get_account_balance($1) r', [
          a,
        ])
      ).rows[0]!.r.total_cents,
    ).toBe(0);
  });
  it('splits charges without moving or mutating the kitchen order', async () => {
    const a = await createOrder();
    await identity(db, ids.cashier);
    const item = (
      await db.query<{ id: string }>(
        'select id from public.order_items where order_id in(select id from public.orders where account_id=$1)',
        [a],
      )
    ).rows[0]!.id;
    const result = (
      await db.query<{ r: { target_account_id: string } }>(
        "select public.move_account_items($1,null,'Nuovo conto',$2,$3,null,$4) r",
        [
          a,
          JSON.stringify([{ item_id: item, quantity: 2 }]),
          await version('accounts', a),
          crypto.randomUUID(),
        ],
      )
    ).rows[0]!.r;
    expect(
      (
        await db.query<{ r: { total_cents: number } }>('select public.get_account_balance($1) r', [
          a,
        ])
      ).rows[0]!.r.total_cents,
    ).toBe(1001);
    expect(
      (
        await db.query<{ r: { total_cents: number } }>('select public.get_account_balance($1) r', [
          result.target_account_id,
        ])
      ).rows[0]!.r.total_cents,
    ).toBe(2002);
    expect(
      (
        await db.query<{ quantity: number }>(
          'select quantity from public.order_items where id=$1',
          [item],
        )
      ).rows[0]!.quantity,
    ).toBe(3);
    const workspace = (
      await db.query<{ r: { orders: { items: { quantity: number }[] }[] } }>(
        'select public.get_account_workspace($1) r',
        [result.target_account_id],
      )
    ).rows[0]!.r;
    expect(workspace.orders[0]!.items[0]!.quantity).toBe(2);
  });

  async function onlinePayment() {
    const account = await createOrder();
    await db.exec("reset role; update public.feature_flags set licensed=true where name='STRIPE'");
    await db.query(
      "update public.venue_settings set payment_methods=array['CASH','STRIPE']::public.payment_method[] where venue_id=$1",
      [ids.venue],
    );
    await db.query(
      "update public.cash_registers set payment_methods=array['CASH','STRIPE']::public.payment_method[] where id=$1",
      [register],
    );
    await identity(db, ids.cashier);
    await db.query('select public.set_cash_register_open($1,true)', [register]);
    await db.query('select public.open_service_session($1,null,$2,0,$3)', [
      ids.venue,
      register,
      crypto.randomUUID(),
    ]);
    const payment = (
      await db.query<{ r: { id: string } }>(
        "select public.create_payment($1,$2,3003,100,'STRIPE',$3,'[]',null) r",
        [account, register, crypto.randomUUID()],
      )
    ).rows[0]!.r.id;
    const operation = (
      await db.query<{ r: { id: string } }>('select public.prepare_provider_operation($1,null) r', [
        payment,
      ])
    ).rows[0]!.r.id;
    return { account, payment, operation };
  }
  it('allows only the server to claim and confirm online charges', async () => {
    const { operation } = await onlinePayment();
    await expect(
      db.query('select public.claim_provider_operation($1)', [operation]),
    ).rejects.toThrow('permission denied');
  });
  it('keeps unknown outcomes reserved and reuses the provider command', async () => {
    const { payment, operation, account } = await onlinePayment();
    await db.exec('reset role; set role service_role');
    const op = (
      await db.query<{ r: { lease_token: string; amount_cents: number } }>(
        'select public.claim_provider_operation($1) r',
        [operation],
      )
    ).rows[0]!.r;
    expect(op.amount_cents).toBe(3103);
    await db.query('select public.release_provider_lease($1,$2)', [operation, op.lease_token]);
    await identity(db, ids.cashier);
    expect(
      (
        await db.query<{ r: { id: string } }>(
          'select public.prepare_provider_operation($1,null) r',
          [payment],
        )
      ).rows[0]!.r.id,
    ).toBe(operation);
    expect(
      (
        await db.query<{ r: { pending_cents: number } }>(
          'select public.get_account_balance($1) r',
          [account],
        )
      ).rows[0]!.r.pending_cents,
    ).toBe(3003);
  });
  it('deduplicates verified receipts and never downgrades completed payments', async () => {
    const { operation, payment } = await onlinePayment();
    await db.exec('reset role; set role service_role');
    const lease = (
      await db.query<{ r: { lease_token: string } }>(
        'select public.claim_provider_operation($1) r',
        [operation],
      )
    ).rows[0]!.r.lease_token;
    const finish = () =>
      db.query(
        "select public.finish_provider_operation($1,null,'cs_test_123','COMPLETED',3103,'EUR','event-paid',null)",
        [operation],
      );
    await db.query(
      "select public.finish_provider_operation($1,$2,'cs_test_123','WAITING',3103,'EUR','event-wait',null)",
      [operation, lease],
    );
    await finish();
    await finish();
    await db.query(
      "select public.finish_provider_operation($1,null,'cs_test_123','WAITING',3103,'EUR','late-wait',null)",
      [operation],
    );
    await identity(db, ids.cashier);
    expect(
      (
        await db.query<{ status: string }>('select status from public.payments where id=$1', [
          payment,
        ])
      ).rows[0]!.status,
    ).toBe('COMPLETED');
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*)::int n from public.cash_journal where payment_id=$1',
          [payment],
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
  it('rejects a provider result with a different amount', async () => {
    const { operation } = await onlinePayment();
    await db.exec('reset role; set role service_role');
    await expect(
      db.query(
        "select public.finish_provider_operation($1,null,'cs_wrong','COMPLETED',1,'EUR','wrong-amount',null)",
        [operation],
      ),
    ).rejects.toThrow('PROVIDER_VERIFICATION_FAILED');
  });

  it('prevents the generic configuration form from changing a room in service', async () => {
    await createOrder();
    await identity(db, ids.admin);
    await expect(
      db.query('select public.save_configuration(\'tables\',$1,$2,\'{"name":"Changed"}\',$3)', [
        ids.venue,
        table,
        await version('tables', table),
      ]),
    ).rejects.toThrow('LAYOUT_IN_SERVICE');
  });
  async function printJob() {
    const account = await createOrder();
    await db.exec('reset role');
    const device = crypto.randomUUID();
    await db.query(
      "insert into public.print_devices(id,venue_id,name,driver,allowed_roles) values($1,$2,'Browser','BROWSER',array['CASHIER']::public.user_role[])",
      [device, ids.venue],
    );
    await identity(db, ids.cashier);
    const key = crypto.randomUUID();
    const request = () =>
      db.query<{ r: { id: string } }>(
        "select public.request_account_print($1,$2,'COURTESY',$3) r",
        [account, device, key],
      );
    const job = (await request()).rows[0]!.r.id;
    expect((await request()).rows[0]!.r.id).toBe(job);
    return job;
  }
  it('does not automatically re-send a leased print with unknown outcome', async () => {
    const job = await printJob();
    await db.query('select public.claim_print_job($1)', [job]);
    await expect(db.query('select public.claim_print_job($1)', [job])).rejects.toThrow(
      'PRINT_RECONCILIATION_REQUIRED',
    );
  });
  it('requires explicit duplicate-risk confirmation for a reprint', async () => {
    const job = await printJob();
    const lease = (
      await db.query<{ r: { job: { lease_token: string } } }>(
        'select public.claim_print_job($1) r',
        [job],
      )
    ).rows[0]!.r.job.lease_token;
    await db.query("select public.finish_print_job($1,$2,false,'unknown')", [job, lease]);
    await expect(
      db.query('select public.retry_print_job($1,false,$2)', [job, crypto.randomUUID()]),
    ).rejects.toThrow('PRINT_RECONCILIATION_REQUIRED');
  });
  async function offlineSnapshot() {
    await db.exec("reset role; update public.feature_flags set licensed=true where name='OFFLINE'");
    const device = crypto.randomUUID();
    await db.query(
      "insert into public.registered_devices(id,user_id,venue_id,display_name,platform,app_version) values($1,$2,$3,'Offline test','TEST','test')",
      [device, ids.waiter, ids.venue],
    );
    await db.query('update private.staff_sessions set device_id=$1 where user_id=$2', [
      device,
      ids.waiter,
    ]);
    await identity(db, ids.waiter);
    const prepared = (
      await db.query<{ r: { challenge_id: string; claims: unknown } }>(
        'select public.prepare_offline_authorization() r',
      )
    ).rows[0]!.r;
    await db.exec('reset role; set role service_role');
    const snapshot = (
      await db.query<{ r: string }>('select public.store_offline_authorization($1,$2,$3) r', [
        prepared.challenge_id,
        JSON.stringify(prepared.claims),
        's'.repeat(86),
      ])
    ).rows[0]!.r;
    await identity(db, ids.waiter);
    return snapshot;
  }
  it('synchronizes a queued order exactly once with offline audit origin', async () => {
    const account = await createOrder(),
      snapshot = await offlineSnapshot();
    const event = crypto.randomUUID(),
      key = crypto.randomUUID(),
      base = await version('accounts', account);
    const payload = JSON.stringify({
      items: [
        { dish_id: dish, quantity: 1, step: 1, removed_ingredients: [], variant_options: [] },
      ],
    });
    const sync = () =>
      db.query<{ r: { status: string } }>(
        "select public.sync_offline_event($1,$2,$3,$4,$5,'CREATE_ORDER',$6,$7,now(),null) r",
        [snapshot, event, key, ids.venue, account, base, payload],
      );
    expect((await sync()).rows[0]!.r.status).toBe('SYNCED');
    expect((await sync()).rows[0]!.r.status).toBe('SYNCED');
    await db.exec('reset role');
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*)::int n from public.orders where account_id=$1',
          [account],
        )
      ).rows[0]!.n,
    ).toBe(2);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.audit_log where action='OFFLINE_EVENT_SYNCED' and offline_origin",
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
  it('keeps an out-of-stock offline event in the conflict center without partial changes', async () => {
    const account = await createOrder(),
      snapshot = await offlineSnapshot();
    const payload = JSON.stringify({
      items: [
        { dish_id: dish, quantity: 3, step: 1, removed_ingredients: [], variant_options: [] },
      ],
    });
    const result = (
      await db.query<{ r: { status: string; result: { reason: string } } }>(
        "select public.sync_offline_event($1,$2,$3,$4,$5,'CREATE_ORDER',$6,$7,now(),null) r",
        [
          snapshot,
          crypto.randomUUID(),
          crypto.randomUUID(),
          ids.venue,
          account,
          await version('accounts', account),
          payload,
        ],
      )
    ).rows[0]!.r;
    expect(result.status).toBe('CONFLICT');
    expect(result.result.reason).toBe('OUT_OF_STOCK');
    await identity(db, ids.admin);
    expect(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.sync_conflicts where status='OPEN'",
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
  it('starts an authorized queued step using the same business command as online', async () => {
    await identity(db, ids.waiter);
    const account = (
      await db.query<{ r: { id: string } }>(
        "select public.create_account($1,'Offline steps',2,null,$2) r",
        [table, crypto.randomUUID()],
      )
    ).rows[0]!.r.id;
    const items = [1, 2].map((step) => ({
      dish_id: dish,
      quantity: 1,
      step,
      removed_ingredients: [],
      variant_options: [],
    }));
    const order = (
      await db.query<{ r: { id: string } }>('select public.create_order($1,$2,$3,$4) r', [
        account,
        JSON.stringify(items),
        crypto.randomUUID(),
        await version('accounts', account),
      ])
    ).rows[0]!.r.id;
    // The dispatcher test starts from an already-served predecessor; actual delivery has its own tests.
    await db.exec('reset role');
    await db.query(
      "update public.order_steps set status='SERVED',served_at=now() where order_id=$1 and step_number=1",
      [order],
    );
    await identity(db, ids.waiter);
    const snapshot = await offlineSnapshot();
    const workspace = (
      await db.query<{ r: { steps: { id: string; version: number; can_start: boolean }[] } }>(
        'select public.get_offline_operational_workspace($1) r',
        [ids.venue],
      )
    ).rows[0]!.r;
    const step = workspace.steps[0]!;
    expect(step.can_start).toBe(true);
    const args = [
      snapshot,
      crypto.randomUUID(),
      crypto.randomUUID(),
      ids.venue,
      step.id,
      step.version,
    ];
    const sync = () =>
      db.query<{ r: { status: string; result: unknown } }>(
        "select public.sync_offline_event($1,$2,$3,$4,$5,'START_STEP',$6,'{}',now(),null) r",
        args,
      );
    expect((await sync()).rows[0]!.r.status).toBe('SYNCED');
    expect((await sync()).rows[0]!.r.status).toBe('SYNCED');
    expect(
      (
        await db.query<{ status: string }>('select status from public.order_steps where id=$1', [
          step.id,
        ])
      ).rows[0]!.status,
    ).toBe('ACTIVE');
  });
  it('resets a cached free table only after PostgreSQL rechecks its version and occupancy', async () => {
    await db.exec('reset role');
    await db.query("update public.tables set technical_status='TO_RESET' where id=$1", [table]);
    await identity(db, ids.waiter);
    const snapshot = await offlineSnapshot();
    const result = (
      await db.query<{ r: { status: string } }>(
        "select public.sync_offline_event($1,$2,$3,$4,$5,'SET_TABLE_AVAILABLE',$6,'{}',now(),null) r",
        [
          snapshot,
          crypto.randomUUID(),
          crypto.randomUUID(),
          ids.venue,
          table,
          await version('tables', table),
        ],
      )
    ).rows[0]!.r;
    expect(result.status).toBe('SYNCED');
    expect(
      (
        await db.query<{ technical_status: string }>(
          'select technical_status from public.tables where id=$1',
          [table],
        )
      ).rows[0]!.technical_status,
    ).toBe('AVAILABLE');
  });
  it('prepares the Host floor without account names, codes or financial workspaces', async () => {
    await createOrder();
    await identity(db, ids.host);
    const result = (
      await db.query<{ r: { accounts: unknown[]; kitchen: unknown[]; floor: unknown } }>(
        'select public.get_offline_operational_workspace($1) r',
        [ids.venue],
      )
    ).rows[0]!.r;
    expect(result.accounts).toEqual([]);
    expect(result.kitchen).toEqual([]);
    expect(result.floor).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/Gruppo|balance|amount_cents|access_code/);
  });
  it('rejects financial commands from the offline dispatcher', async () => {
    const account = await createOrder(),
      snapshot = await offlineSnapshot();
    await expect(
      db.query(
        "select public.sync_offline_event($1,$2,$3,$4,$5,'CREATE_PAYMENT',1,'{}',now(),null)",
        [snapshot, crypto.randomUUID(), crypto.randomUUID(), ids.venue, account],
      ),
    ).rejects.toThrow('INVALID_OFFLINE_EVENT');
  });
});
