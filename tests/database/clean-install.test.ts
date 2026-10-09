import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { database } from './harness';
import { cleanInstallPlan } from '../../scripts/clean-install-plan.mjs';

describe('empty installation and unverified release evidence', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await database();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('creates all recovered rehearsal tables through the versioned installer', async () => {
    const { bootstrapManifest } = await cleanInstallPlan();
    const result = await db.query<{ name: string; rls: boolean; exposed: boolean }>(`
      select n.nspname||'.'||c.relname as name, c.relrowsecurity as rls,
        (has_table_privilege('anon',c.oid,'SELECT') or
         has_table_privilege('authenticated',c.oid,'SELECT') or
         has_table_privilege('service_role',c.oid,'SELECT')) as exposed
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname like 'continuity_rehearsal_%'
        and c.relkind='r' order by name
    `);
    expect(result.rows.map((row) => row.name)).toEqual([...bootstrapManifest.tables].sort());
    expect(result.rows.every((row) => row.rls && !row.exposed)).toBe(true);
  });

  it('retains every applied migration without including bootstrap SQL in its statement', async () => {
    const plan = await cleanInstallPlan();
    const result = await db.query<{ version: string; name: string; sql: string }>(
      `select version,name,array_to_string(statements,E'\\n') as sql
       from supabase_migrations.schema_migrations order by version`,
    );
    expect(result.rows.map(({ version, name }) => ({ version, name }))).toEqual(
      plan.migrations.map(({ version, name }) => ({ version, name })),
    );
    expect(result.rows.map((row) => row.sql)).toEqual(plan.migrations.map((row) => row.sql));
    expect(result.rows.every((row) => !row.sql.includes('Clean-install bootstrap v1'))).toBe(true);
  });

  it('recovers the missing routines with the exact API role restrictions', async () => {
    const plan = await cleanInstallPlan();
    for (const signature of plan.bootstrapManifest.routines) {
      const result = await db.query<{ exists: boolean; anon: boolean }>(
        `select to_regprocedure($1) is not null as exists,
          has_function_privilege('anon',to_regprocedure($1),'EXECUTE') as anon`,
        [signature],
      );
      expect(result.rows[0]).toEqual({ exists: true, anon: false });
    }
    const result = await db.query<{ allowed: boolean }>(
      `select has_function_privilege('authenticated',
        'public.get_order_change_center(uuid)','EXECUTE') as allowed`,
    );
    expect(result.rows[0]!.allowed).toBe(true);
    await expect(
      db.query(`select public.get_order_change_center(
      '10000000-0000-4000-8000-000000000001'::uuid)`),
    ).rejects.toThrow('FORBIDDEN');
  });

  it('refuses bootstrap on an already installed database', async () => {
    const plan = await cleanInstallPlan();
    await expect(db.exec(plan.bootstrap)).rejects.toThrow(
      'CLEAN_INSTALL_REQUIRES_EMPTY_APPLICATION_SCHEMAS',
    );
    await db.exec('rollback');
    const result = await db.query<{ count: number }>(
      'select count(*)::int as count from private.release_test_catalog',
    );
    expect(result.rows[0]!.count).toBeGreaterThan(0);
  });

  it('does not certify tests merely because the historical SQL seeded PASS claims', async () => {
    const result = await db.query<{ gate: { ok: boolean; required_passed: number } }>(
      'select public.release_test_gate() as gate',
    );
    expect(result.rows[0]!.gate.ok).toBe(false);
    expect(result.rows[0]!.gate.required_passed).toBe(0);
    const legacy = await db.query<{ count: number }>(`
      select count(*)::int as count from private.release_test_results
      where status='PENDING' and evidence->>'classification'='UNVERIFIED_LEGACY_CLAIM'
    `);
    expect(legacy.rows[0]!.count).toBeGreaterThanOrEqual(24);
    const claims = await db.query<{ missing: number }>(`
      select count(*)::int as missing from private.release_test_results
      where evidence->>'classification'='UNVERIFIED_LEGACY_CLAIM'
        and not (evidence ?& array['previous_status','previous_evidence',
          'previous_executed_at','previous_executed_by'])
    `);
    expect(claims.rows[0]!.missing).toBe(0);
    const gates = await db.query<{ missing: number }>(`
      select count(*)::int as missing from private.release_gate_checks
      where evidence like 'UNVERIFIED_LEGACY_CLAIM: %'
        and not (substring(evidence from length('UNVERIFIED_LEGACY_CLAIM: ')+1)::jsonb
          ?& array['previous_status','previous_evidence','previous_checked_at','previous_checked_by'])
    `);
    expect(gates.rows[0]!.missing).toBe(0);
  });

  it('rejects fabricated success through both the old writer and direct writes', async () => {
    await expect(
      db.query(`select public.record_release_test_result(
      'RLS_GLOBAL','PASS','{"claim":"no actual test"}'::jsonb,'fixture')`),
    ).rejects.toThrow('ATTESTED_CI_EVIDENCE_REQUIRED');
    await expect(
      db.query(`update private.release_test_results set status='PASS'
      where key='RLS_GLOBAL'`),
    ).rejects.toThrow('ATTESTED_CI_EVIDENCE_REQUIRED');
    await expect(
      db.query(`select public.set_release_gate_check(
      'AUTH_LEAKED_PASSWORD_PROTECTION','PASS','unverified','fixture')`),
    ).rejects.toThrow('ATTESTED_CI_EVIDENCE_REQUIRED');
    await expect(
      db.query(`update private.release_gate_checks set status='PASS'
      where key='AUTH_LEAKED_PASSWORD_PROTECTION'`),
    ).rejects.toThrow('ATTESTED_CI_EVIDENCE_REQUIRED');
  });
});
