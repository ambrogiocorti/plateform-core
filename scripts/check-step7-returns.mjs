import assert from 'node:assert/strict';
import { database, identity, ids, seed, sessionId } from '../tests/database/harness.ts';

const room = 'a7000000-0000-4000-8000-000000000001';
const layout = 'a7000000-0000-4000-8000-000000000002';
const zone = 'a7000000-0000-4000-8000-000000000003';
const table = 'a7000000-0000-4000-8000-000000000004';
const station = 'a7000000-0000-4000-8000-000000000005';
const category = 'a7000000-0000-4000-8000-000000000006';
const dish = 'a7000000-0000-4000-8000-000000000007';
const ingredient = 'a7000000-0000-4000-8000-000000000008';
const cook = 'a7000000-0000-4000-8000-000000000010';
const pass = 'a7000000-0000-4000-8000-000000000011';
const kitchenAdmin = 'a7000000-0000-4000-8000-000000000012';
const accountKey = 'a7000000-0000-4000-8000-000000000020';
const orderKey = 'a7000000-0000-4000-8000-000000000021';
const remakeKey = 'a7000000-0000-4000-8000-000000000022';
const cancelKey = 'a7000000-0000-4000-8000-000000000023';
const resolveKey = 'a7000000-0000-4000-8000-000000000024';

const db = await database();
try {
  await seed(db);
  await db.exec(`
    insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','STEP7 room');
    insert into public.room_layouts(id,venue_id,room_id,name,active)
      values('${layout}','${ids.venue}','${room}','STEP7 layout',true);
    insert into public.zones(id,venue_id,room_id,name) values('${zone}','${ids.venue}','${room}','STEP7 zone');
    insert into public.tables(id,venue_id,room_id,layout_id,zone_id,number,name,seats)
      values('${table}','${ids.venue}','${room}','${layout}','${zone}',701,'STEP7 table',4);
    insert into public.stations(id,venue_id,name) values('${station}','${ids.venue}','STEP7 kitchen');
    insert into public.table_assignments(venue_id,waiter_id,mode,zone_id)
      values('${ids.venue}','${ids.waiter}','ZONE','${zone}');
    insert into public.categories(id,name) values('${category}','STEP7 category');
    insert into public.dishes(id,category_id,name,price_cents) values('${dish}','${category}','STEP7 dish',1800);
    insert into public.ingredients(id,name) values('${ingredient}','STEP7 ingredient');
    insert into public.dish_ingredients values('${dish}','${ingredient}',false);
    insert into public.venue_dish_settings(venue_id,dish_id,availability,availability_date,local_station_id)
      values('${ids.venue}','${dish}',10,(now() at time zone 'Europe/Rome')::date,'${station}');
    insert into public.dish_station_assignments values('${ids.venue}','${dish}','${station}',true);
    update public.venue_settings set returns_enabled=true where venue_id='${ids.venue}';

    insert into auth.users(id) values('${cook}'),('${pass}'),('${kitchenAdmin}');
    insert into public.staff_profiles(id,display_name,role,scope) values
      ('${cook}','STEP7 cook','KITCHEN_STAFF','VENUE'),
      ('${pass}','STEP7 pass','PASS','VENUE'),
      ('${kitchenAdmin}','STEP7 kitchen admin','KITCHEN_ADMIN','VENUE');
    insert into public.staff_venue_assignments(user_id,venue_id) values
      ('${cook}','${ids.venue}'),('${pass}','${ids.venue}'),('${kitchenAdmin}','${ids.venue}');
    insert into auth.sessions(id,user_id) values
      ('${sessionId(cook)}','${cook}'),('${sessionId(pass)}','${pass}'),('${sessionId(kitchenAdmin)}','${kitchenAdmin}');
    insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
      select id,user_id,now(),now()+interval '2 hours'
      from auth.sessions where user_id in ('${cook}','${pass}','${kitchenAdmin}');
    insert into public.station_staff_assignments values('${ids.venue}','${station}','${cook}',true);
  `);

  await identity(db, ids.waiter);
  const account = (
    await db.query(`select public.create_account($1,'STEP7 guest',2,null,$2) as result`, [
      table,
      accountKey,
    ])
  ).rows[0]?.result;
  assert.ok(account?.id, 'waiter creates account');
  const accountState = await db.query('select version from public.accounts where id=$1', [
    account.id,
  ]);
  const order = (
    await db.query('select public.create_order($1,$2,$3,$4) as result', [
      account.id,
      JSON.stringify([{ dish_id: dish, quantity: 1, step: 1 }]),
      orderKey,
      accountState.rows[0]?.version,
    ])
  ).rows[0]?.result;
  assert.ok(order?.id, 'waiter creates unpaid order');

  await db.exec('reset role');
  await identity(db, cook);
  let board = (await db.query('select public.get_kitchen_board($1) as board', [ids.venue])).rows[0]
    ?.board;
  let item = board?.find((entry) => entry.order_id === order.id);
  assert.ok(item, 'kitchen sees order item');
  await db.query("select public.transition_order_item($1,'IN_PREPARATION',$2)", [
    item.id,
    item.version,
  ]);
  await db.query("select public.transition_order_item($1,'READY',$2)", [item.id, item.version + 1]);

  await db.exec('reset role');
  await identity(db, ids.waiter);
  await assert.rejects(
    () =>
      db.query("select public.return_order_item($1,'REMAKE',$2,$3)", [
        item.id,
        item.version + 2,
        remakeKey,
      ]),
    /FORBIDDEN/,
    'waiter cannot process returned dish',
  );

  await db.exec('reset role');
  await identity(db, pass);
  board = (await db.query('select public.get_kitchen_board($1) as board', [ids.venue])).rows[0]
    ?.board;
  item = board?.find((entry) => entry.id === item.id);
  assert.ok(item, 'pass reads authoritative current item version');
  const remake = (
    await db.query("select public.return_order_item($1,'REMAKE',$2,$3) as result", [
      item.id,
      item.version,
      remakeKey,
    ])
  ).rows[0]?.result;
  assert.ok(remake?.id, 'PASS remake succeeds');
  const remakeReplay = (
    await db.query("select public.return_order_item($1,'REMAKE',$2,$3) as result", [
      item.id,
      item.version,
      remakeKey,
    ])
  ).rows[0]?.result;
  assert.deepEqual(remakeReplay, remake, 'REMAKE replay is idempotent');

  await db.exec('reset role');
  let technical = await db.query('select status from public.order_items where id=$1', [item.id]);
  assert.equal(technical.rows[0]?.status, 'RECEIVED', 'remake returns item to kitchen queue');
  assert.equal(
    (
      await db.query(
        'select count(*)::int as count from public.returned_items where order_item_id=$1 and action=$2',
        [item.id, 'REMAKE'],
      )
    ).rows[0]?.count,
    1,
    'idempotent replay does not duplicate returned_items',
  );
  assert.equal(
    (
      await db.query(
        'select availability from public.venue_dish_settings where venue_id=$1 and dish_id=$2',
        [ids.venue, dish],
      )
    ).rows[0]?.availability,
    8,
    'remake consumes one additional portion',
  );

  await identity(db, cook);
  board = (await db.query('select public.get_kitchen_board($1) as board', [ids.venue])).rows[0]
    ?.board;
  item = board?.find((entry) => entry.id === item.id);
  assert.ok(item, 'remade item returns to kitchen board');
  await db.query("select public.transition_order_item($1,'IN_PREPARATION',$2)", [
    item.id,
    item.version,
  ]);
  await db.query("select public.transition_order_item($1,'READY',$2)", [item.id, item.version + 1]);

  await db.exec('reset role');
  await identity(db, kitchenAdmin);
  board = (await db.query('select public.get_kitchen_board($1) as board', [ids.venue])).rows[0]
    ?.board;
  item = board?.find((entry) => entry.id === item.id);
  assert.ok(item, 'kitchen admin reads current item version');
  const cancel = (
    await db.query("select public.return_order_item($1,'CANCEL_REQUEST',$2,$3) as result", [
      item.id,
      item.version,
      cancelKey,
    ])
  ).rows[0]?.result;
  assert.ok(cancel?.request_id, 'cancellation creates approval request');

  await db.exec('reset role');
  assert.equal(
    (
      await db.query('select status from public.order_change_requests where id=$1', [
        cancel.request_id,
      ])
    ).rows[0]?.status,
    'PENDING',
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from public.notifications where resource_type='order_change_requests' and resource_id=$1 and recipient_role='ADMIN' and category='RETURN_APPROVAL'",
        [cancel.request_id],
      )
    ).rows[0]?.count,
    1,
    'admin receives return approval notification',
  );

  await identity(db, ids.admin);
  const resolved = (
    await db.query('select public.resolve_order_change($1,true,$2,$3) as result', [
      cancel.request_id,
      'STEP7 integration approval',
      resolveKey,
    ])
  ).rows[0]?.result;
  assert.equal(resolved?.status, 'APPROVED', 'Admin approves cancellation');

  await db.exec('reset role');
  technical = await db.query('select status from public.order_items where id=$1', [item.id]);
  assert.equal(technical.rows[0]?.status, 'CANCELLED', 'approved return cancels unpaid item');
  assert.equal(
    (
      await db.query(
        'select availability from public.venue_dish_settings where venue_id=$1 and dish_id=$2',
        [ids.venue, dish],
      )
    ).rows[0]?.availability,
    8,
    'prepared cancelled food is not returned to stock',
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from public.audit_log where action='ITEM_RETURNED' and resource_id=$1",
        [item.id],
      )
    ).rows[0]?.count,
    2,
    'remake and cancellation request are audited',
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from public.audit_log where action='ORDER_CORRECTED' and resource_id=$1",
        [order.id],
      )
    ).rows[0]?.count,
    1,
    'approved cancellation correction is audited',
  );

  console.log('STEP7_RETURNS_GATE=PASSED');
} finally {
  await db.exec('reset role').catch(() => undefined);
  await db.close();
}
