import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed, sessionId } from './harness';

async function stepUp(
  db: PGlite,
  user: string,
  action: string,
  resource: string | null = null,
): Promise<string> {
  await db.exec('reset role; set role service_role');
  const result = await db.query<{ grant: string }>(
    'select public.issue_step_up_grant($1,$2,$3,$4) as grant',
    [user, sessionId(user), action, resource],
  );
  await db.exec('reset role');
  await identity(db, user);
  return result.rows[0]!.grant;
}

describe('Step 1 staff access and credential lifecycle', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
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

  it('returns only staff inside the administrator management boundary', async () => {
    await identity(db, ids.admin);
    const result = await db.query<{
      workspace: { staff: Array<{ id: string; can_manage: boolean }> };
    }>('select public.get_staff_management_workspace() as workspace');
    const staff = result.rows[0]!.workspace.staff;
    expect(staff.some((entry) => entry.id === ids.waiter && entry.can_manage)).toBe(true);
    expect(staff.some((entry) => entry.id === ids.superAdmin)).toBe(false);
  });

  it('suggests a stable staff identifier and avoids duplicates already present in Auth', async () => {
    await db.exec(
      "update auth.users set email='mario.rossi@staff.test' where id='" + ids.waiter + "'",
    );
    await identity(db, ids.admin);
    const result = await db.query<{ identifier: string }>(
      "select public.suggest_staff_identifier('Mario Rossi') as identifier",
    );
    // The live identifier generator appends numeric collision suffixes
    // directly to the normalized name, preserving deterministic uniqueness.
    expect(result.rows[0]!.identifier).toBe('mario.rossi2@staff.test');
    const retry = await db.query<{ identifier: string }>(
      "select public.suggest_staff_identifier('Mario Rossi') as identifier",
    );
    expect(retry.rows).toEqual(result.rows);
  });

  it('accepts an authorized custom staff email domain without changing the configured default', async () => {
    await identity(db, ids.superAdmin);
    const grant = await stepUp(db, ids.superAdmin, 'PRIVILEGED_STAFF');
    const values = {
      display_name: 'Admin Sede collaudo',
      identifier: 'sede.collaudo@custom.example',
      role: 'ADMIN',
      scope: 'CHAIN',
      venue_ids: [],
    };
    const result = await db.query<{ job: { id: string; user_id: string; status: string } }>(
      "select public.begin_staff_admin_job('CREATE',$1::jsonb,$2,$3) as job",
      [JSON.stringify(values), crypto.randomUUID(), grant],
    );
    expect(result.rows[0]!.job.status).toBe('PENDING');
    const persisted = await db.query<{ identifier: string }>(
      "select values->>'identifier' as identifier from public.staff_admin_jobs where id=$1",
      [result.rows[0]!.job.id],
    );
    expect(persisted.rows[0]!.identifier).toBe(values.identifier);
    expect(
      (
        await db.query<{ domain: string }>(
          'select staff_identity_domain as domain from public.restaurant_profile where id',
        )
      ).rows[0]!.domain,
    ).toBe('staff.test');
  });

  it('updates role/scope atomically and invalidates stale operational credentials', async () => {
    await db.exec(`insert into private.staff_pins(user_id,pin_hash)
      values('${ids.waiter}',extensions.crypt('192847',extensions.gen_salt('bf',4)))`);
    await identity(db, ids.admin);
    const grant = await stepUp(db, ids.admin, 'STAFF_CHANGE', ids.waiter);
    const version = (
      await db.query<{ version: number }>('select version from public.staff_profiles where id=$1', [
        ids.waiter,
      ])
    ).rows[0]!.version;
    await db.query(
      `select public.update_staff_access($1,$2,'CASHIER','VENUE',$3::uuid[],$4,$5,$6,$7)`,
      [
        ids.waiter,
        'Waiter aggiornato',
        [ids.venue],
        version,
        'Cambio mansione test',
        grant,
        crypto.randomUUID(),
      ],
    );
    await db.exec('reset role');
    expect(
      (
        await db.query<{ role: string; name: string }>(
          'select role,display_name as name from public.staff_profiles where id=$1',
          [ids.waiter],
        )
      ).rows,
    ).toEqual([{ role: 'CASHIER', name: 'Waiter aggiornato' }]);
    expect(
      (await db.query('select 1 from private.staff_pins where user_id=$1', [ids.waiter])).rows,
    ).toEqual([]);
    expect(
      (
        await db.query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from private.staff_sessions where user_id=$1',
          [ids.waiter],
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
  });

  it('requires a new step-up grant and explicit reason to reactivate a disabled account', async () => {
    await db.exec(`update public.staff_profiles set active=false where id='${ids.waiter}'`);
    await identity(db, ids.admin);
    const grant = await stepUp(db, ids.admin, 'STAFF_CHANGE', ids.waiter);
    const key = crypto.randomUUID();
    const started = await db.query<{ job: { id: string; user_id: string; status: string } }>(
      `select public.begin_staff_admin_job('REACTIVATE',$1::jsonb,$2,$3) as job`,
      [
        JSON.stringify({
          user_id: ids.waiter,
          reason: 'Identità verificata al banco',
          identity_verified: true,
        }),
        key,
        grant,
      ],
    );
    const job = started.rows[0]!.job;
    expect(job.user_id).toBe(ids.waiter);
    await db.exec('reset role; set role service_role');
    const claimed = await db.query<{ job: { lease_token: string } }>(
      'select public.claim_staff_admin_job($1) as job',
      [job.id],
    );
    await db.query('select public.finish_staff_admin_job($1,$2,true)', [
      job.id,
      claimed.rows[0]!.job.lease_token,
    ]);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ active: boolean }>(
          'select active from public.staff_profiles where id=$1',
          [ids.waiter],
        )
      ).rows,
    ).toEqual([{ active: true }]);
  });

  it('revokes an individual application session only after step-up', async () => {
    await identity(db, ids.waiter);
    const grant = await stepUp(db, ids.waiter, 'SESSION_REVOKE', sessionId(ids.waiter));
    await db.query('select public.revoke_staff_session($1,$2)', [sessionId(ids.waiter), grant]);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from private.staff_sessions where session_id=$1',
          [sessionId(ids.waiter)],
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
  });

  it('makes password-change commands durable and invalidates the current operational session', async () => {
    await identity(db, ids.waiter);
    const grant = await stepUp(db, ids.waiter, 'CHANGE_PASSWORD', ids.waiter);
    const result = await db.query<{ job: { id: string; status: string } }>(
      'select public.begin_own_password_job($1,$2) as job',
      [crypto.randomUUID(), grant],
    );
    expect(result.rows[0]!.job.status).toBe('PENDING');
    await db.exec('reset role');
    expect(
      (
        await db.query<{ revoked: boolean }>(
          'select revoked_at is not null as revoked from private.staff_sessions where session_id=$1',
          [sessionId(ids.waiter)],
        )
      ).rows,
    ).toEqual([{ revoked: true }]);
  });

  it('keeps the staff job read policy scoped to the initiating privileged user', async () => {
    await db.exec(`insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values,status)
      values('${ids.admin}',gen_random_uuid(),'${ids.waiter}','DISABLE','{}','COMPLETED'),
            ('${ids.superAdmin}',gen_random_uuid(),'${ids.admin}','DISABLE','{}','COMPLETED')`);
    await identity(db, ids.admin);
    const rows = await db.query<{ actor_id: string }>(
      'select actor_id from public.staff_admin_jobs',
    );
    expect(rows.rows).toEqual([{ actor_id: ids.admin }]);
  });
});
