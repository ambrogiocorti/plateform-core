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

describe('upgrade preserves manually recorded legacy release claims', () => {
  let db: PGlite;
  let previous: {
    test: { evidence: Record<string, unknown>; executed_at: string; executed_by: string };
    gate: { evidence: string; checked_at: string; checked_by: string };
  };
  beforeAll(async () => {
    const plan = await cleanInstallPlan();
    const forward = plan.migrations.findIndex((row) => row.version === '20261009003541');
    expect(forward).toBeGreaterThan(0);
    db = await database(forward);
    // Explicit fixture DATA before the actual forward migration. No hidden
    // application DDL, no claimed execution and no shared database writes.
    await db.exec(`
      update private.release_test_results set status='PASS',
        evidence='{"fixture":"explicit upgrade regression","original":true}'::jsonb,
        executed_at='2026-10-07T08:09:10Z',executed_by='upgrade-test-fixture'
        where key='RLS_GLOBAL';
      update private.release_gate_checks set status='PASS',
        evidence='Explicit upgrade fixture, not a release attestation',
        checked_at='2026-10-07T09:10:11Z',checked_by='upgrade-gate-fixture'
        where key='AUTH_LEAKED_PASSWORD_PROTECTION';
    `);
    previous = (
      await db.query<{ snapshot: typeof previous }>(`
      select jsonb_build_object(
        'test',(select to_jsonb(r) from private.release_test_results r where key='RLS_GLOBAL'),
        'gate',(select to_jsonb(g) from private.release_gate_checks g
          where key='AUTH_LEAKED_PASSWORD_PROTECTION')) as snapshot
    `)
    ).rows[0]!.snapshot;
    await db.exec(plan.migrations[forward]!.sql);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('withdraws a test PASS while retaining the exact previous evidence, actor and timestamp', async () => {
    const result = (
      await db.query<{ row: Record<string, unknown> }>(`
      select to_jsonb(r) as row from private.release_test_results r where key='RLS_GLOBAL'
    `)
    ).rows[0]!.row;
    expect(result.status).toBe('PENDING');
    expect(result.executed_at).toBeNull();
    expect(result.executed_by).toBeNull();
    expect(result.evidence).toEqual({
      classification: 'UNVERIFIED_LEGACY_CLAIM',
      previous_status: 'PASS',
      previous_evidence: previous.test.evidence,
      previous_executed_at: previous.test.executed_at,
      previous_executed_by: previous.test.executed_by,
    });
  });

  it('withdraws a manual gate PASS while retaining the exact previous evidence, actor and timestamp', async () => {
    const result = (
      await db.query<{ row: Record<string, unknown> }>(`
      select to_jsonb(g) as row from private.release_gate_checks g
        where key='AUTH_LEAKED_PASSWORD_PROTECTION'
    `)
    ).rows[0]!.row;
    expect(result.status).toBe('PENDING');
    expect(result.checked_at).toBeNull();
    expect(result.checked_by).toBeNull();
    const prefix = 'UNVERIFIED_LEGACY_CLAIM: ';
    expect(String(result.evidence).startsWith(prefix)).toBe(true);
    expect(JSON.parse(String(result.evidence).slice(prefix.length))).toEqual({
      previous_status: 'PASS',
      previous_evidence: previous.gate.evidence,
      previous_checked_at: previous.gate.checked_at,
      previous_checked_by: previous.gate.checked_by,
    });
  });
});
