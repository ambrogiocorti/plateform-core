import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';
const service = 'e0000000-0000-4000-8000-000000000001',
  booking = 'e0000000-0000-4000-8000-000000000002',
  live = 'e0000000-0000-4000-8000-000000000003',
  customer = 'e0000000-0000-4000-8000-000000000004';
describe('personal data and approved retention', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
    await db.query(
      "insert into public.services(id,venue_id,name,starts_at,ends_at) values($1,$2,'Cena','19:00','23:00')",
      [service, ids.venue],
    );
    await db.query(
      "insert into public.reservations(id,venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status,customer_note,internal_note,allergies) values($1,$2,$3,current_date-200,'19:00','Anna','Bianchi','+39000011111',2,'COMPLETED','Near the window','Internal only','Milk'),($4,$2,$3,current_date+1,'19:00','Live','','+39000022222',2,'RESERVED',null,null,null)",
      [booking, ids.venue, service, live],
    );
  });
  beforeEach(async () => {
    await db.exec('reset role;begin');
    await identity(db, ids.admin);
  });
  afterEach(async () => {
    await db.exec('rollback;reset role');
  });
  afterAll(async () => {
    await db?.close();
  });
  async function grant(resource: string | null = booking): Promise<string> {
    await db.exec('reset role');
    const id = crypto.randomUUID();
    await db.query(
      "insert into private.step_up_grants(id,user_id,session_id,action,resource_id,expires_at) values($1,$2,$3,'PRIVACY',$4,now()+interval '3 minutes')",
      [id, ids.admin, sessionId(ids.admin), resource],
    );
    await identity(db, ids.admin);
    return id;
  }
  async function change(action: string, changes: unknown = {}, resource = booking, version = 1) {
    return db.query<{ r: { id: string; version: number } }>(
      'select public.change_reservation_privacy($1,$2,$3,$4,$5,$6,$7) r',
      [
        resource,
        version,
        action,
        JSON.stringify(changes),
        'Verified customer request',
        await grant(resource),
        crypto.randomUUID(),
      ],
    );
  }
  it('exports only the selected authorized booking and excludes internal staff notes', async () => {
    const data = (
      await db.query<{ r: Record<string, unknown> }>(
        'select public.export_reservation_personal_data($1,$2) r',
        [booking, await grant()],
      )
    ).rows[0]!.r;
    expect(JSON.stringify(data)).toContain('Anna');
    expect(JSON.stringify(data)).toContain('Near the window');
    expect(JSON.stringify(data)).not.toContain('Internal only');
    expect(
      (
        await db.query<{ r: unknown[] }>('select public.search_privacy_reservations($1,$2) r', [
          ids.venue,
          '+39000011111',
        ])
      ).rows[0]!.r,
    ).toHaveLength(1);
  });
  it('does not disclose booking personal data to the technical Super Admin', async () => {
    await identity(db, ids.superAdmin);
    await expect(
      db.query('select public.search_privacy_reservations($1,$2)', [ids.venue, '+39000011111']),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('does not expose the data of another venue', async () => {
    await expect(
      db.query('select public.search_privacy_reservations($1,$2)', [
        ids.otherVenue,
        '+39000011111',
      ]),
    ).rejects.toThrow('VENUE_FORBIDDEN');
  });
  it('rectifies a completed reservation without changing covers, status or monetary history', async () => {
    await change('RECTIFY', { first_name: 'Ann', last_name: 'Brown', phone: '+39000011112' });
    const r = (
      await db.query<{ first_name: string; party_size: number; status: string }>(
        'select first_name,party_size,status from public.reservations where id=$1',
        [booking],
      )
    ).rows[0]!;
    expect(r).toMatchObject({ first_name: 'Ann', party_size: 2, status: 'COMPLETED' });
  });
  it('anonymizes contact and sensitive free text while retaining the operating history', async () => {
    await change('ANONYMIZE');
    const r = (
      await db.query<{
        first_name: string;
        phone: string;
        allergies: string | null;
        internal_note: string | null;
        party_size: number;
        anonymized_at: string;
      }>(
        'select first_name,phone,allergies,internal_note,party_size,anonymized_at from public.reservations where id=$1',
        [booking],
      )
    ).rows[0]!;
    expect(r).toMatchObject({
      first_name: 'Ospite',
      phone: `anon:${booking}`,
      allergies: null,
      internal_note: null,
      party_size: 2,
    });
    expect(r.anonymized_at).toBeTruthy();
  });
  it('requires release of a preservation hold before anonymization', async () => {
    const result = await change('HOLD');
    await expect(change('ANONYMIZE', {}, booking, result.rows[0]!.r.version)).rejects.toThrow(
      'PRIVACY_HOLD',
    );
  });
  it('never anonymizes an active or future booking', async () => {
    await expect(change('ANONYMIZE', {}, live)).rejects.toThrow('RESERVATION_STILL_ACTIVE');
  });
  it('does not allow a venue Admin to change the global retention policy', async () => {
    await expect(
      db.query("select public.configure_data_retention(1,'{}',null,$1)", [crypto.randomUUID()]),
    ).rejects.toThrow('CHAIN_SCOPE_REQUIRED');
  });
  it('keeps automated deletion disabled until a policy has been explicitly configured', async () => {
    await db.exec('reset role;set role service_role');
    expect(
      (await db.query<{ r: { enabled: boolean } }>('select public.run_data_retention() r')).rows[0]!
        .r,
    ).toEqual({ enabled: false });
  });
  it('applies configured retention in bounded batches without deleting immutable audit', async () => {
    await db.exec("reset role;update public.staff_profiles set scope='CHAIN' where role='ADMIN'");
    await identity(db, ids.admin);
    const settings = {
      reservation_days: 180,
      customer_session_days: 30,
      telemetry_days: 30,
      error_days: 30,
      signal_days: 1,
      enabled: true,
    };
    await db.query('select public.configure_data_retention(1,$1,$2,$3)', [
      JSON.stringify(settings),
      await grant(null),
      crypto.randomUUID(),
    ]);
    await db.exec('reset role;set role service_role');
    const result = (
      await db.query<{ r: { reservations_anonymized: number } }>(
        'select public.run_data_retention(10) r',
      )
    ).rows[0]!.r;
    expect(result.reservations_anonymized).toBe(1);
    await db.exec('reset role');
    expect(
      (await db.query<{ count: number }>('select count(*)::integer count from public.audit_log'))
        .rows[0]!.count,
    ).toBeGreaterThan(0);
    expect(
      (
        await db.query<{ status: string }>('select status from public.reservations where id=$1', [
          live,
        ])
      ).rows[0]!.status,
    ).toBe('RESERVED');
  });
  it('uses a durable lease and backoff for expired technical identities', async () => {
    await db.exec('reset role');
    await db.query('insert into auth.users(id) values($1)', [customer]);
    await db.exec(
      'update public.restaurant_settings set retention=retention||\'{"enabled":true}\'',
    );
    await db.exec('set role service_role');
    await db.query('select public.register_customer_identity_retention($1)', [customer]);
    await db.exec('reset role');
    await db.query(
      "update private.customer_identity_retention set eligible_at=now()-interval '1 day' where user_id=$1",
      [customer],
    );
    await db.exec('set role service_role');
    const claim = (
      await db.query<{ r: { user_id: string; lease_token: string } }>(
        'select public.claim_customer_identity_cleanup() r',
      )
    ).rows[0]!.r;
    expect(claim.user_id).toBe(customer);
    expect(
      (await db.query<{ r: unknown }>('select public.claim_customer_identity_cleanup() r')).rows[0]!
        .r,
    ).toBeNull();
    await db.query('select public.finish_customer_identity_cleanup($1,$2,false)', [
      customer,
      claim.lease_token,
    ]);
    expect(
      (await db.query<{ r: unknown }>('select public.claim_customer_identity_cleanup() r')).rows[0]!
        .r,
    ).toBeNull();
  });
});
