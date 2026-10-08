import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

const service = '70000000-0000-4000-8000-000000000001';
describe('Booking pacing and session security', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}';
      insert into public.services(id,venue_id,name,starts_at,ends_at) values('${service}','${ids.venue}','Cena','19:00','23:00');
      insert into public.service_booking_rules(venue_id,service_id,max_covers_service,max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm)
        values('${ids.venue}','${service}',20,2,10,6);
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

  async function book(
    phone = '+390000000001',
    party = 2,
    time = '19:00',
    key = crypto.randomUUID(),
  ) {
    const result = await db.query<{ result: { id: string; status: string } }>(
      `select public.create_public_reservation($1,$2,(now() at time zone 'Europe/Rome')::date+1,$3,'Cliente','Test',$4,$5,'{}',$6,$7) as result`,
      [ids.venue, service, time, phone, party, key, 'b'.repeat(64)],
    );
    return result.rows[0]?.result;
  }

  it('confirms ordinary bookings and requires approval for large parties', async () => {
    expect((await book())?.status).toBe('RESERVED');
    expect((await book('+390000000002', 7, '19:30'))?.status).toBe('REQUESTED');
  });
  it('enforces arrivals per slot independently of total service covers', async () => {
    await book();
    await book('+390000000002');
    await expect(book('+390000000003')).rejects.toThrow('BOOKING_CAPACITY_REACHED');
  });
  it('enforces covers per slot independently of total service covers', async () => {
    await book('+390000000001', 6);
    await expect(book('+390000000002', 5)).rejects.toThrow('BOOKING_CAPACITY_REACHED');
  });
  it('rejects off-grid times, duplicate bookings and closed slots', async () => {
    await db.exec('savepoint before_invalid');
    await expect(book('+390000000001', 2, '19:10')).rejects.toThrow('BOOKING_SLOT_UNAVAILABLE');
    await db.exec('rollback to savepoint before_invalid');
    await book();
    await db.exec('savepoint before_duplicate');
    await expect(book()).rejects.toThrow('BOOKING_DUPLICATE');
    await db.exec('rollback to savepoint before_duplicate');
    await db.exec(
      `insert into public.booking_time_slots(venue_id,service_id,service_date,slot_time,closed) values('${ids.venue}','${service}',(now() at time zone 'Europe/Rome')::date+1,'20:00',true)`,
    );
    await expect(book('+390000000002', 2, '20:00')).rejects.toThrow('BOOKING_CLOSED');
  });
  it('rejects direct anonymous booking writes and exposes only public form metadata', async () => {
    await db.exec('set role anon');
    expect(
      (await db.query('select public.get_booking_configuration($1)', [ids.venue])).rows,
    ).toHaveLength(1);
    await expect(book()).rejects.toThrow('permission denied');
  });
  it('retains rate limit counters across rejected attempts when called as a separate transaction', async () => {
    await db.exec('set role service_role');
    expect(
      (await db.query('select public.consume_edge_rate_limit($1,2,600) as allowed', ['test'])).rows,
    ).toEqual([{ allowed: true }]);
    await db.query('select public.consume_edge_rate_limit($1,2,600)', ['test']);
    expect(
      (await db.query('select public.consume_edge_rate_limit($1,2,600) as allowed', ['test'])).rows,
    ).toEqual([{ allowed: false }]);
  });
  it('immediately rejects a JWT whose Supabase session has been removed', async () => {
    await db.query('delete from auth.sessions where id=$1', [sessionId(ids.admin)]);
    await identity(db, ids.admin);
    expect((await db.query('select private.current_role() as role')).rows).toEqual([
      { role: null },
    ]);
  });
  it('blocks operational access after a local session lock without bypass via complete_staff_login', async () => {
    await identity(db, ids.waiter);
    await db.query('select public.lock_staff_session()');
    expect((await db.query('select private.current_role() as role')).rows).toEqual([
      { role: null },
    ]);
    await expect(
      db.query("select public.complete_staff_login('Test','Windows','test')"),
    ).rejects.toThrow('PIN_OR_FULL_AUTH_REQUIRED');
  });
  it('verifies a hashed PIN and persists wrong attempt counters', async () => {
    await identity(db, ids.waiter);
    await db.query("select public.set_staff_pin('492815')");
    await db.query('select public.lock_staff_session()');
    expect(
      (await db.query("select public.unlock_staff_session('000000') as result")).rows[0],
    ).toMatchObject({ result: { ok: false } });
    await db.exec('reset role');
    expect((await db.query('select failed_attempts from private.staff_pins')).rows).toEqual([
      { failed_attempts: 1 },
    ]);
    await db.exec('update private.staff_pins set locked_until=null');
    await identity(db, ids.waiter);
    expect(
      (await db.query("select public.unlock_staff_session('492815') as result")).rows[0],
    ).toMatchObject({ result: { ok: true } });
    expect((await db.query('select private.current_role() as role')).rows).toEqual([
      { role: 'WAITER' },
    ]);
  });
});
