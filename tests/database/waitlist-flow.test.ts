import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

const service = '70000000-0000-4000-8000-000000000007';
const rateKey = 'b'.repeat(64);

describe('waitlist: privilege boundary, offer priority and atomic acceptance', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.exec(`
      update public.restaurant_profile
      set public_content=public_content || '{"privacy_url":"https://restaurant.test/privacy"}'::jsonb;
      update public.venue_settings set reservations_enabled=true where venue_id='${ids.venue}';
      insert into public.services(id,venue_id,name,starts_at,ends_at)
      values('${service}','${ids.venue}','Cena','19:00','23:00');
      insert into public.service_booking_rules(
        venue_id,service_id,max_covers_service,max_arrivals_per_slot,
        max_covers_per_slot,max_party_size_auto_confirm
      ) values('${ids.venue}','${service}',20,4,12,8);
      update public.feature_flags set licensed=true where name='WAITLIST';
      insert into public.venue_features(venue_id,name,enabled)
      values('${ids.venue}','WAITLIST',true);
    `);
  });
  beforeEach(async () => db.exec('begin'));
  afterEach(async () => db.exec('rollback; reset role'));
  afterAll(async () => db?.close());

  async function create(name: string, key = crypto.randomUUID()) {
    const result = await db.query<{ response: { id: string; status: string } }>(
      `
      select public.create_waitlist_entry(
        $1,$2,(now() at time zone 'Europe/Rome')::date+2,
        '19:00'::time,null,2,$3,'+393331234567',null,$4,$5
      ) as response`,
      [ids.venue, service, name, key, rateKey],
    );
    return result.rows[0]?.response;
  }

  it('does not permit anonymous direct registration via a privileged RPC', async () => {
    await db.exec('set role anon');
    await db.exec('savepoint denied_create');
    await expect(create('Maria Rossi')).rejects.toThrow('permission denied');
    await db.exec('rollback to savepoint denied_create');
    await db.exec('savepoint denied_accept');
    await expect(
      db.query('select public.accept_waitlist_offer($1,$2,$3)', [
        crypto.randomUUID(),
        'a'.repeat(64),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('permission denied');
    await db.exec('rollback to savepoint denied_accept');
  });

  it('creates an unconfirmed request and preserves idempotency', async () => {
    await db.exec('set role service_role');
    const key = crypto.randomUUID();
    const first = await create('Maria Rossi', key);
    expect(first?.status).toBe('WAITING');
    expect(await create('Maria Rossi', key)).toEqual(first);
    await db.exec('savepoint different_payload');
    await expect(create('Altra persona', key)).rejects.toThrow('IDEMPOTENCY_MISMATCH');
    await db.exec('rollback to savepoint different_payload');
    expect(
      (await db.query(`select count(*)::integer as total from public.waitlist_entries`)).rows,
    ).toEqual([{ total: 1 }]);
  });

  it('orders offers authoritatively and converts only a valid token into a reservation', async () => {
    await db.exec('set role service_role');
    const first = await create('Maria Rossi');
    const second = await create('Giulia Bianchi');
    if (!first || !second) throw new Error('WAITLIST_TEST_SETUP_FAILED');
    await db.exec('reset role');
    await identity(db, ids.host);
    const day = `(now() at time zone 'Europe/Rome')::date+2`;
    const candidates = await db.query<{ response: { candidates: { id: string }[] } }>(`
      select public.get_waitlist_candidates('${ids.venue}','${service}',${day},'19:00',50) as response`);
    expect(candidates.rows[0]?.response.candidates.map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
    ]);

    await db.exec('savepoint priority_conflict');
    await expect(
      db.query(`select public.offer_waitlist_slot($1,'19:00',15,$2)`, [
        second.id,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('WAITLIST_PRIORITY_CONFLICT');
    await db.exec('rollback to savepoint priority_conflict');
    const offered = await db.query<{ response: { status: string; access_token: string } }>(
      `
      select public.offer_waitlist_slot($1,'19:00',15,$2) as response`,
      [first.id, crypto.randomUUID()],
    );
    expect(offered.rows[0]?.response.status).toBe('OFFERED');
    const token = offered.rows[0]?.response.access_token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    await db.exec('reset role');
    await db.exec('set role service_role');
    await db.exec('savepoint forged_accept');
    await expect(
      db.query(`select public.accept_waitlist_offer($1,$2,$3)`, [
        first.id,
        'f'.repeat(64),
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow('WAITLIST_ACCESS_DENIED');
    await db.exec('rollback to savepoint forged_accept');

    const acceptanceKey = crypto.randomUUID();
    const accepted = await db.query<{
      response: {
        status: string;
        reservation_status: string;
        reservation_id: string;
      };
    }>(`select public.accept_waitlist_offer($1,$2,$3) as response`, [
      first.id,
      token,
      acceptanceKey,
    ]);
    expect(accepted.rows[0]?.response).toMatchObject({
      status: 'CONVERTED_TO_RESERVATION',
      reservation_status: 'RESERVED',
    });
    const retry = await db.query<{ response: unknown }>(
      `select public.accept_waitlist_offer($1,$2,$3) as response`,
      [first.id, token, acceptanceKey],
    );
    expect(retry.rows[0]?.response).toEqual(accepted.rows[0]?.response);
    await db.exec('savepoint mismatched_replay');
    await expect(
      db.query(`select public.accept_waitlist_offer($1,$2,$3)`, [
        first.id,
        'f'.repeat(64),
        acceptanceKey,
      ]),
    ).rejects.toThrow('IDEMPOTENCY_MISMATCH');
    await db.exec('rollback to savepoint mismatched_replay');
    expect(
      (await db.query(`select status from public.waitlist_entries where id=$1`, [first.id])).rows,
    ).toEqual([{ status: 'CONVERTED_TO_RESERVATION' }]);
  });
});
