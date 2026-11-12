import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

const room = '80000000-0000-4000-8000-000000000001';
const layout = '80000000-0000-4000-8000-000000000002';
const table = '80000000-0000-4000-8000-000000000003';
const otherRoom = '80000000-0000-4000-8000-000000000004';
const service = '80000000-0000-4000-8000-000000000005';
const reservation = '80000000-0000-4000-8000-000000000006';

describe('Cross-venue isolation and Host transitions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}';
      update public.feature_flags set licensed=true where name='MULTI_VENUE';
      insert into public.venues(id,name,slug,code,address,phone) values('${ids.otherVenue}','Altra sede','altra-sede','V2','Via 2','+390000000002');
      insert into public.venue_settings(venue_id) values('${ids.otherVenue}');
      insert into public.rooms(id,venue_id,name) values('${room}','${ids.venue}','Sala autorizzata'),('${otherRoom}','${ids.otherVenue}','Sala privata');
      insert into public.room_layouts(id,venue_id,room_id,name,active) values('${layout}','${ids.venue}','${room}','Cena',true);
      insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values('${table}','${ids.venue}','${room}','${layout}',1,'Tavolo 1',4);
      insert into public.services(id,venue_id,name,starts_at,ends_at) values('${service}','${ids.venue}','Cena','19:00','23:00');
      insert into public.reservations(id,venue_id,service_id,service_date,slot_time,first_name,phone,party_size,status)
        values('${reservation}','${ids.venue}','${service}',current_date,'20:00','Cliente','+390000000001',2,'RESERVED');
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

  it('filters rooms and venues at the database boundary', async () => {
    await identity(db, ids.admin);
    expect((await db.query('select id from public.venues')).rows).toEqual([{ id: ids.venue }]);
    expect((await db.query('select id from public.rooms')).rows).toEqual([{ id: room }]);
  });
  it('rejects a different venue even when the client substitutes an existing resource ID', async () => {
    await identity(db, ids.admin);
    await expect(
      db.query('select public.save_configuration(\'rooms\',$1,$2,\'{"name":"Tampered"}\',1)', [
        ids.venue,
        otherRoom,
      ]),
    ).rejects.toThrow('VENUE_FORBIDDEN');
  });
  it('rejects attempts to inject venue_id into configuration values', async () => {
    await identity(db, ids.admin);
    await expect(
      db.query("select public.save_configuration('rooms',$1,null,$2,null)", [
        ids.venue,
        JSON.stringify({ name: 'Forged', venue_id: ids.otherVenue }),
      ]),
    ).rejects.toThrow('UNKNOWN_FIELD');
  });
  it('does not allow a venue Admin to create venues or edit the shared catalog', async () => {
    await identity(db, ids.admin);
    await db.exec('savepoint before_venue');
    // Use the actual 11-parameter public RPC. An Admin of one venue cannot
    // create venues even when MULTI_VENUE is enabled for the installation.
    await expect(
      db.query(
        "select public.create_venue('Other','other','V3','Via','+390000000003',null,'Europe/Rome','EUR','it-IT',null,$1)",
        [crypto.randomUUID()],
      ),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint before_venue');
    await expect(
      db.query(
        'select public.save_configuration(\'categories\',null,null,\'{"name":"Forbidden"}\',null)',
      ),
    ).rejects.toThrow('CHAIN_SCOPE_REQUIRED');
  });
  it('prevents disabling multi-venue while two venues remain active', async () => {
    await db.exec("update public.feature_flags set licensed=false where name='MULTI_VENUE'");
    await expect(db.exec('set constraints all immediate')).rejects.toThrow('MULTI_VENUE_DISABLED');
  });
  it('lets Host assign, welcome and seat a reservation through the workflow', async () => {
    await identity(db, ids.host);
    const suggestions = await db.query<{ result: { id: string }[] }>(
      'select public.suggest_tables($1) as result',
      [reservation],
    );
    expect(suggestions.rows[0]?.result[0]?.id).toBe(table);
    await db.query('select public.assign_table($1,$2,false)', [reservation, table]);
    await db.query("select public.transition_reservation($1,'ARRIVED',2)", [reservation]);
    await db.query("select public.transition_reservation($1,'SEATED',3)", [reservation]);
    expect((await db.query('select technical_status from public.tables')).rows).toEqual([
      { technical_status: 'OCCUPIED' },
    ]);
  });
  it('keeps no-show tables reserved until Host explicitly releases them', async () => {
    await identity(db, ids.host);
    await db.query('select public.assign_table($1,$2,false)', [reservation, table]);
    await db.query("select public.transition_reservation($1,'NO_SHOW',2)", [reservation]);
    expect((await db.query('select technical_status from public.tables')).rows).toEqual([
      { technical_status: 'RESERVED' },
    ]);
    await db.query('select public.set_table_available($1)', [table]);
    expect((await db.query('select technical_status from public.tables')).rows).toEqual([
      { technical_status: 'AVAILABLE' },
    ]);
  });
  it('offers configured joinable tables for groups and atomically assigns the accepted proposal', async () => {
    const second = '80000000-0000-4000-8000-000000000007';
    await db.query(
      `insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values($1,$2,$3,$4,2,'Tavolo 2',2)`,
      [second, ids.venue, room, layout],
    );
    await db.query('update public.reservations set party_size=6 where id=$1', [reservation]);
    await identity(db, ids.host);
    expect(
      (await db.query('select public.suggest_tables($1) as result', [reservation])).rows[0],
    ).toEqual({ result: [] });
    await identity(db, ids.admin);
    await db.query('select public.configure_table_join($1,$2,true)', [table, second]);
    await identity(db, ids.host);
    const suggestions = (
      await db.query<{
        result: { id: string; table_ids: string[]; seats: number; requires_merge: boolean }[];
      }>('select public.suggest_tables($1) as result', [reservation])
    ).rows[0]!.result;
    expect(suggestions[0]).toMatchObject({ seats: 6, requires_merge: true });
    await db.query('select public.assign_table_group($1,$2,false,2)', [
      reservation,
      [table, second],
    ]);
    expect(
      (await db.query('select table_id from public.reservations where id=$1', [reservation]))
        .rows[0],
    ).toEqual({ table_id: table });
    expect(
      (await db.query('select technical_status from public.tables order by number')).rows,
    ).toEqual([{ technical_status: 'RESERVED' }, { technical_status: 'RESERVED' }]);
    await db.query("select public.transition_reservation($1,'ARRIVED',3)", [reservation]);
    await db.query("select public.transition_reservation($1,'SEATED',4)", [reservation]);
    expect(
      (await db.query('select technical_status from public.tables order by number')).rows,
    ).toEqual([{ technical_status: 'OCCUPIED' }, { technical_status: 'OCCUPIED' }]);
    await expect(db.query('select public.split_tables($1)', [table])).rejects.toThrow(
      'TABLE_GROUP_IN_SERVICE',
    );
  });
  it('paginates Host reservations without exposing them to waiters', async () => {
    await db.query(
      `insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,phone,party_size,status) values($1,$2,current_date,'21:00','Secondo','+390000000002',3,'RESERVED')`,
      [ids.venue, service],
    );
    await identity(db, ids.host);
    const first = (
      await db.query<{
        result: {
          items: { id: string; slot_time: string }[];
          total: number;
          has_more: boolean;
          covers: number;
        };
      }>(
        "select public.get_host_reservations($1,current_date,null,null,'',null,null,1) as result",
        [ids.venue],
      )
    ).rows[0]!.result;
    expect(first).toMatchObject({ has_more: true, total: 2, covers: 5 });
    expect(first.items).toHaveLength(1);
    const second = (
      await db.query<{ result: { items: { id: string }[]; has_more: boolean } }>(
        "select public.get_host_reservations($1,current_date,null,null,'',$2,$3,1) as result",
        [ids.venue, first.items[0]!.slot_time, first.items[0]!.id],
      )
    ).rows[0]!.result;
    expect(second.has_more).toBe(false);
    expect(second.items[0]?.id).not.toBe(first.items[0]!.id);
    await identity(db, ids.waiter);
    await expect(
      db.query('select public.get_host_reservations($1,current_date)', [ids.venue]),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('checks seated guests when moving a group before any account has been opened', async () => {
    const target = '80000000-0000-4000-8000-000000000007';
    await db.query(
      `insert into public.tables(id,venue_id,room_id,layout_id,number,name,seats) values($1,$2,$3,$4,2,'Tavolo piccolo',1)`,
      [target, ids.venue, room, layout],
    );
    await identity(db, ids.host);
    await db.query('select public.assign_table($1,$2,false)', [reservation, table]);
    await db.query("select public.transition_reservation($1,'ARRIVED',2)", [reservation]);
    await db.query("select public.transition_reservation($1,'SEATED',3)", [reservation]);
    await expect(db.query('select public.move_table($1,$2,true)', [table, target])).rejects.toThrow(
      'TABLE_CAPACITY_INSUFFICIENT',
    );
  });
  it('blocks reservation mutations when disabled while preserving independent walk-in reception', async () => {
    await db.query(
      'update public.venue_settings set reservations_enabled=false where venue_id=$1',
      [ids.venue],
    );
    await identity(db, ids.host);
    await db.exec('savepoint disabled_booking');
    await expect(
      db.query('select public.assign_table($1,$2,false)', [reservation, table]),
    ).rejects.toThrow('RESERVATIONS_DISABLED');
    await db.exec('rollback to savepoint disabled_booking');
    const arrival = (
      await db.query<{ result: { id: string } }>(
        "select public.create_walk_in($1,$2,2,'Walk-in',$3) as result",
        [ids.venue, service, crypto.randomUUID()],
      )
    ).rows[0]!.result;
    expect(arrival.id).toBeTruthy();
  });
});
