import assert from 'node:assert/strict';
import { database, identity, ids, seed } from '../tests/database/harness.ts';

const venueB = ids.otherVenue;
const roomB = 'aa000000-0000-4000-8000-000000000001';
const layoutB = 'aa000000-0000-4000-8000-000000000002';
const tableB = 'aa000000-0000-4000-8000-000000000003';
const serviceB = 'aa000000-0000-4000-8000-000000000004';
const reservationB = 'aa000000-0000-4000-8000-000000000005';
const signalB = 'aa000000-0000-4000-8000-000000000006';
const uploadB = 'aa000000-0000-4000-8000-000000000007';
const objectB = 'aa000000-0000-4000-8000-000000000008';
const documentPath = `venues/${venueB}/documents/private.pdf`;

const db = await database();
try {
  await seed(db);
  await db.exec(`
    update public.feature_flags set licensed=true where name='MULTI_VENUE';
    insert into public.venues(id,name,slug,code,address,phone)
      values('${venueB}','STEP10 private venue','step10-private','V2','Via seconda 2','+390000000002');
    insert into public.venue_settings(venue_id,reservations_enabled) values('${venueB}',true);
    insert into public.rooms(id,venue_id,name) values('${roomB}','${venueB}','Private room');
    insert into public.room_layouts(id,venue_id,room_id,name,active)
      values('${layoutB}','${venueB}','${roomB}','Private layout',true);
    insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats)
      values('${tableB}','${venueB}','${roomB}','${layoutB}',901,'Private table',4);
    insert into public.services(id,venue_id,name,starts_at,ends_at)
      values('${serviceB}','${venueB}','Private dinner','19:00','23:00');
    insert into public.reservations(id,venue_id,service_id,service_date,slot_time,first_name,phone,party_size,status)
      values('${reservationB}','${venueB}','${serviceB}',current_date,'20:00','Private guest','+390000000099',2,'RESERVED');
    insert into public.realtime_signals(id,venue_id,topic,resource_id)
      values('${signalB}','${venueB}','FLOOR','${tableB}');
    insert into public.asset_uploads(id,actor_id,bucket,venue_id,path,size_bytes,mime,status,checksum,saved_at)
      values('${uploadB}','${ids.superAdmin}','documents','${venueB}','${documentPath}',10,'application/pdf','SAVED','step10',now());
    insert into storage.objects(id,bucket_id,name,metadata)
      values('${objectB}','documents','${documentPath}','{"size":10,"mimetype":"application/pdf"}'::jsonb);
  `);

  await identity(db, ids.admin);
  assert.deepEqual(await rows('select id from public.venues where id=$1', [venueB]), []);
  assert.deepEqual(await rows('select id from public.rooms where id=$1', [roomB]), []);
  assert.deepEqual(await rows('select id from public.tables where id=$1', [tableB]), []);
  assert.deepEqual(
    await rows('select id from public.reservations where id=$1', [reservationB]),
    [],
  );
  assert.deepEqual(await rows('select id from public.realtime_signals where id=$1', [signalB]), []);
  assert.deepEqual(await rows('select id from public.asset_uploads where id=$1', [uploadB]), []);
  assert.deepEqual(await rows('select id from storage.objects where id=$1', [objectB]), []);
  await assert.rejects(
    () => db.query('select public.get_floor_workspace($1)', [venueB]),
    /VENUE_FORBIDDEN/,
    'manipulated venue id is rejected by RPC boundary',
  );
  await assert.rejects(
    () => db.query("update public.tables set name='FORGED' where id=$1 returning id", [tableB]),
    /permission denied|row-level security|VENUE_FORBIDDEN/,
    'cross-venue direct update is denied at the table boundary',
  );

  await db.exec('reset role');
  assert.equal(
    (await db.query('select name from public.tables where id=$1', [tableB])).rows[0]?.name,
    'Private table',
    'blocked write did not mutate private venue',
  );
  await db.query(
    'insert into public.staff_venue_assignments(user_id,venue_id,active) values($1,$2,true)',
    [ids.admin, venueB],
  );

  await identity(db, ids.admin);
  assert.equal((await rows('select id from public.venues where id=$1', [venueB])).length, 1);
  assert.equal((await rows('select id from public.rooms where id=$1', [roomB])).length, 1);
  assert.equal((await rows('select id from public.tables where id=$1', [tableB])).length, 1);
  assert.equal(
    (await rows('select id from public.reservations where id=$1', [reservationB])).length,
    1,
  );
  assert.equal(
    (await rows('select id from public.realtime_signals where id=$1', [signalB])).length,
    1,
  );
  assert.equal(
    (await rows('select id from public.asset_uploads where id=$1', [uploadB])).length,
    1,
  );
  assert.equal((await rows('select id from storage.objects where id=$1', [objectB])).length, 1);

  await db.exec('reset role');
  await db.query(
    'update public.staff_venue_assignments set active=false where user_id=$1 and venue_id=$2',
    [ids.admin, venueB],
  );
  await identity(db, ids.admin);
  assert.deepEqual(await rows('select id from public.tables where id=$1', [tableB]), []);
  assert.deepEqual(await rows('select id from public.realtime_signals where id=$1', [signalB]), []);
  assert.deepEqual(await rows('select id from storage.objects where id=$1', [objectB]), []);

  console.log('STEP10_CROSS_VENUE_RLS_GATE=PASSED');
} finally {
  await db.exec('reset role').catch(() => undefined);
  await db.close();
}

async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
