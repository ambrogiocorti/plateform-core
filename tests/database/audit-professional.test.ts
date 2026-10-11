import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { database, identity, ids, seed } from './harness';

type Page = {
  events: { id: string; action: string; category: string; severity: string; action_label: string; emitter_source: string; timestamp: string }[];
  has_more: boolean;
};

describe('Security & Business Audit hardening', () => {
  let db: PGlite;
  const request = 'a5000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    // Audit-specific, isolated PGlite test: the unrelated Step 11 RPC permission
    // manifest migration currently blocks the full migration replay.
    // This does NOT count as a passing full-history migration gate.
    const migrations = (await readdir('supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const cutoff = migrations.findIndex((name) =>
      name.startsWith('20261008163112_step11_public_rpc_permission_manifest'),
    );
    if (cutoff < 0) throw new Error('STEP11_BASELINE_NOT_FOUND');
    db = await database(cutoff);
    for (const migration of [
      '20261011073505_audit_professional_catalog_filters_noise.sql',
      '20261011074105_audit_event_catalog_canonical_seed.sql',
      '20261011074842_audit_safe_device_assignment_diff_fields.sql',
      '20261011075739_audit_privacy_sensitive_read_and_catalog_truth.sql',
    ]) {
      await db.exec(await readFile(`supabase/migrations/${migration}`, 'utf8'));
    }
    await seed(db);
    await db.query(
      `insert into public.audit_log(timestamp,actor_type,actor_user_id,actor_role,venue_id,action,resource_type,resource_id,operation,result,request_id,correlation_id)
       select '2026-09-15T12:00:00Z','STAFF',$1,'CASHIER',$2,'PAYMENTS_UPDATE','payments',gen_random_uuid(),'UPDATE','SUCCESS',$3,$3
       from generate_series(1,3)`,
      [ids.cashier, ids.venue, request],
    );
  });
  beforeEach(async () => {
    await db.exec('begin');
    await identity(db, ids.superAdmin);
  });
  afterEach(async () => {
    await db.exec('rollback; reset role');
  });
  afterAll(async () => {
    await db?.close();
  });

  it('catalogues observed actions, but labels missing security events PLANNED', async () => {
    const catalog = (
      await db.query<{ data: Array<{ action: string; implementation_status: string }> }>(
        'select public.get_audit_event_catalog() as data',
      )
    ).rows[0]!.data;
    expect(catalog.length).toBeGreaterThanOrEqual(148);
    expect(catalog).toContainEqual(
      expect.objectContaining({ action: 'AUTH_LOGIN_FAILED', implementation_status: 'PLANNED' }),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ action: 'PAYMENTS_UPDATE', implementation_status: 'OBSERVED' }),
    );
  });

  it('filters category/severity before paginating, without skipped tied events', async () => {
    const page = async (before?: { id: string; timestamp: string }) =>
      (
        await db.query<{ data: Page }>(
          `select public.search_audit_professional(
            p_request=>$1,p_category=>'FINANCE',p_severity=>'CRITICAL',
            p_before_at=>$2,p_before_id=>$3,p_limit=>2
          ) as data`,
          [request, before?.timestamp ?? null, before?.id ?? null],
        )
      ).rows[0]!.data;
    const first = await page();
    expect(first.events).toHaveLength(2);
    expect(first.has_more).toBe(true);
    const second = await page(first.events.at(-1));
    expect(second.events).toHaveLength(1);
    expect(second.has_more).toBe(false);
    expect(new Set([...first.events, ...second.events].map((x) => x.id)).size).toBe(3);
    expect(first.events[0]).toMatchObject({
      category: 'FINANCE',
      severity: 'CRITICAL',
      action: 'PAYMENTS_UPDATE',
      emitter_source: 'DATABASE_AUDIT',
    });
    expect(first.events[0]?.action_label).toBeTruthy();
    const noMatch = (
      await db.query<{ data: Page }>(
        `select public.search_audit_professional(p_request=>$1,p_category=>'MENU_INVENTORY') as data`,
        [request],
      )
    ).rows[0]!.data;
    expect(noMatch.events).toEqual([]);
  });

  it('rejects non Super Admin and invalid input', async () => {
    for (const user of [ids.admin, ids.cashier]) {
      await identity(db, user);
      await db.exec('savepoint denied');
      await expect(db.query('select public.search_audit_professional()')).rejects.toThrow(
        'FORBIDDEN',
      );
      await db.exec('rollback to savepoint denied');
      await db.exec('savepoint denied_catalog');
      await expect(db.query('select public.get_audit_event_catalog()')).rejects.toThrow(
        'FORBIDDEN',
      );
      await db.exec('rollback to savepoint denied_catalog');
    }
    await identity(db, ids.superAdmin);
    await db.exec('savepoint invalid');
    await expect(
      db.query("select public.search_audit_professional(p_category=>'INVALID')"),
    ).rejects.toThrow('INVALID_FILTER');
    await db.exec('rollback to savepoint invalid');
    await expect(
      db.query('select public.search_audit_professional(p_before_id=>$1)', [request]),
    ).rejects.toThrow('INVALID_FILTER');
  });

  it('excludes device heartbeat and keeps device security/configuration changes', async () => {
    // Inspect the DB trigger as the PGlite fixture owner: browser roles have
    // no direct INSERT/UPDATE grants for this table by design.
    await db.exec('reset role');
    const id = 'e5000000-0000-4000-8000-000000000001';
    await db.query(
      `insert into public.registered_devices(id,user_id,venue_id,display_name,platform,app_version)
        values($1,$2,$3,'Audit device','WEB','1.0.0')`,
      [id, ids.superAdmin, ids.venue],
    );
    const count = async () =>
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.audit_log where action='REGISTERED_DEVICES_UPDATE' and resource_id=$1",
          [id],
        )
      ).rows[0]!.n;
    const before = await count();
    await db.query(
      `update public.registered_devices set last_seen_at=last_seen_at+interval '1 second',
        app_version='1.0.1' where id=$1`,
      [id],
    );
    expect(await count()).toBe(before);
    await db.query(
      "update public.registered_devices set assigned_role_or_station='PASS' where id=$1",
      [id],
    );
    expect(await count()).toBe(before + 1);
    const latest = (
      await db.query<{
        old_values: Record<string, unknown>;
        new_values: Record<string, unknown>;
      }>(
        `select old_values,new_values from public.audit_log
         where action='REGISTERED_DEVICES_UPDATE' and resource_id=$1
         order by timestamp desc,id desc limit 1`,
        [id],
      )
    ).rows[0]!;
    expect(latest.old_values.assigned_role_or_station).not.toBe(
      latest.new_values.assigned_role_or_station,
    );
    expect(latest.new_values).not.toHaveProperty('display_name');
    expect(latest.new_values).not.toHaveProperty('user_agent');
  });

  it('audits authorized private reservation contact reads without persisting PII', async () => {
    const service = 'e1000000-0000-4000-8000-000000000011';
    const reservation = 'e1000000-0000-4000-8000-000000000012';
    await db.exec('reset role');
    await db.query(
      "insert into public.services(id,venue_id,name,starts_at,ends_at) values($1,$2,'Cena','19:00','23:00')",
      [service, ids.venue],
    );
    await db.query(
      "insert into public.reservations(id,venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status) values($1,$2,$3,current_date+1,'19:00','Sensitive','Guest','+390099988877',2,'RESERVED')",
      [reservation, ids.venue, service],
    );
    await identity(db, ids.admin);
    const result = (
      await db.query<{ data: Array<{ id: string }> }>(
        'select public.search_privacy_reservations($1,$2) data',
        [ids.venue, '+390099988877'],
      )
    ).rows[0]!.data;
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(reservation);

    await db.exec('reset role');
    const events = (
      await db.query<{
        action: string;
        actor_user_id: string;
        old_values: Record<string, unknown>;
        new_values: Record<string, unknown>;
        resource_type: string;
      }>(
        "select action,actor_user_id,old_values,new_values,resource_type from public.audit_log where action='SENSITIVE_DATA_ACCESS' order by timestamp desc,id desc",
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'SENSITIVE_DATA_ACCESS',
      actor_user_id: ids.admin,
      resource_type: 'reservation_privacy_search',
    });
    expect(events[0]?.new_values).toHaveProperty('purpose', 'AUTHORIZED_CONTACT_LOOKUP');
    expect(JSON.stringify(events)).not.toContain('Sensitive');
    expect(JSON.stringify(events)).not.toContain('+390099988877');

    const observed = (
      await db.query<{ status: string }>(
        "select implementation_status as status from private.audit_event_catalog where action='SENSITIVE_DATA_ACCESS'",
      )
    ).rows[0]!.status;
    expect(observed).toBe('OBSERVED');

    await identity(db, ids.superAdmin);
    await db.exec('savepoint denied');
    await expect(
      db.query('select public.search_privacy_reservations($1,$2)', [
        ids.venue,
        '+390099988877',
      ]),
    ).rejects.toThrow('FORBIDDEN');
    await db.exec('rollback to savepoint denied');
  });

});
