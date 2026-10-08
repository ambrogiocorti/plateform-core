import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database, identity, ids, seed } from './harness';

describe('PostgreSQL migrations and installation invariants', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
    await seed(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('enables RLS on every application table including audit partitions', async () => {
    const result = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity`,
    );
    expect(result.rows).toEqual([]);
  });
  it('also enables fail-closed RLS on private application tables', async () => {
    const result = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind in ('r','p') and not c.relrowsecurity`,
    );
    expect(result.rows).toEqual([]);
  });
  it('preserves independent request and correlation IDs in audit and telemetry', async () => {
    const requestId = crypto.randomUUID(),
      correlationId = crypto.randomUUID();
    await db.query("select set_config('request.headers',$1,false)", [
      JSON.stringify({ 'x-request-id': requestId, 'x-correlation-id': correlationId }),
    ]);
    await db.query("select private.audit('FOUNDATION_CORRELATION','test',null,null)");
    const audit = await db.query<{ request_id: string; correlation_id: string }>(
      "select request_id,correlation_id from public.audit_log where action='FOUNDATION_CORRELATION'",
    );
    expect(audit.rows).toEqual([{ request_id: requestId, correlation_id: correlationId }]);
    await db.query(
      "select public.ingest_edge_telemetry('HTTP_SUCCESS','development','0.1.0','foundation',12,'OK',200,$1)",
      [requestId],
    );
    const telemetry = await db.query<{ request_id: string; correlation_id: string }>(
      'select request_id,correlation_id from public.telemetry_events where request_id=$1',
      [requestId],
    );
    expect(telemetry.rows).toEqual(audit.rows);
    await db.exec("select set_config('request.headers','{}',false)");
  });
  it('grants anonymous execution only to explicit public read projections', async () => {
    const result = await db.query<{
      name: string;
    }>(`select p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and has_function_privilege('anon',p.oid,'EXECUTE') order by p.proname`);
    expect(result.rows.map((row) => row.name)).toEqual([
      'get_booking_configuration',
      'get_public_menu',
      'get_public_site',
    ]);
  });
  it('denies direct API writes and service-only RPC execution to staff', async () => {
    const tables = await db.query<{
      name: string;
    }>(`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and
      (has_table_privilege('authenticated',c.oid,'INSERT') or has_table_privilege('authenticated',c.oid,'UPDATE') or has_table_privilege('authenticated',c.oid,'DELETE') or has_table_privilege('anon',c.oid,'TRUNCATE'))`);
    expect(tables.rows).toEqual([]);
    const service = await db.query<{
      name: string;
    }>(`select p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('bootstrap_technical_user','consume_edge_rate_limit','store_offline_authorization','ingest_edge_telemetry','prepare_staff_job_profile')
      and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`);
    expect(service.rows).toEqual([]);
  });
  it('keeps future tables and functions private until their grants are explicitly reviewed', async () => {
    await db.exec('begin');
    try {
      await db.exec(`create table public.foundation_permission_probe(id uuid);
        alter table public.foundation_permission_probe enable row level security;
        create function public.foundation_permission_probe() returns boolean language sql as $$ select true $$`);
      const result = await db.query<{ allowed: boolean }>(`select
        has_function_privilege('anon','public.foundation_permission_probe()','EXECUTE') or
        has_function_privilege('authenticated','public.foundation_permission_probe()','EXECUTE') or
        has_table_privilege('anon','public.foundation_permission_probe','INSERT') or
        has_table_privilege('authenticated','public.foundation_permission_probe','UPDATE') as allowed`);
      expect(result.rows).toEqual([{ allowed: false }]);
    } finally {
      await db.exec('rollback');
    }
  });
  it('rejects a second restaurant profile', async () => {
    await expect(
      db.exec(
        `insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain) values('Other','https://other.test','https://staff.other.test','other.test')`,
      ),
    ).rejects.toThrow();
  });
  it('rejects a second active venue while MULTI_VENUE is false', async () => {
    await expect(
      db.exec(
        `insert into public.venues(id,name,slug,code,address,phone) values('${ids.otherVenue}','Other','other','V2','Via 2','+39000')`,
      ),
    ).rejects.toThrow('MULTI_VENUE_DISABLED');
  });

  it('lets the assigned venue Admin manage the shared catalog while the installation is mono-venue', async () => {
    await db.exec('begin');
    try {
      await identity(db, ids.admin);
      expect((await db.query('select private.can_manage_shared_catalog() allowed')).rows).toEqual([
        { allowed: true },
      ]);
      const category = (
        await db.query<{ result: { id: string } }>(
          "select public.save_configuration_command('categories',null,null,$1::jsonb,null,$2) result",
          [
            JSON.stringify({ name: 'Catalogo mono-sede', active: true, sort_order: 0 }),
            crypto.randomUUID(),
          ],
        )
      ).rows[0]!.result;
      expect(category.id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await db.exec('reset role; rollback');
    }
  });
  it('cannot deactivate the only venue', async () => {
    await expect(
      db.exec(`update public.venues set active=false where id='${ids.venue}'`),
    ).rejects.toThrow('FIRST_VENUE_REQUIRED');
  });
  it('prevents even a database owner from changing audit through ordinary SQL', async () => {
    await expect(db.exec(`update public.audit_log set action='FORGED'`)).rejects.toThrow(
      'IMMUTABLE_RECORD',
    );
    await expect(db.exec(`delete from public.audit_log`)).rejects.toThrow('IMMUTABLE_RECORD');
    await expect(db.exec(`truncate public.audit_log`)).rejects.toThrow('IMMUTABLE_RECORD');
  });
  it('denies privileged role access with aal1', async () => {
    await identity(db, ids.superAdmin, 'aal1');
    const result = await db.query<{ role: string | null }>('select private.current_role() as role');
    expect(result.rows[0]?.role).toBeNull();
    await db.exec('reset role');
  });
  it('reads roles from the database and enforces venue scope', async () => {
    await identity(db, ids.admin);
    const result = await db.query<{ allowed: boolean; forbidden: boolean }>(
      `select private.has_venue('${ids.venue}') as allowed, private.has_venue('${ids.otherVenue}') as forbidden`,
    );
    expect(result.rows).toEqual([{ allowed: true, forbidden: false }]);
    await expect(
      db.exec(`update public.staff_profiles set scope='CHAIN' where id='${ids.admin}'`),
    ).rejects.toThrow();
    await db.exec('reset role');
  });
});
