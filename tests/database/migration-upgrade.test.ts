import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { database } from './harness';

// Upgrade of an installation whose history stops where Development stopped
// (480 versions, up to 20261012075338) without the two replay-only
// compatibility migrations. They are recorded, never executed, after the
// read-only preflight passes; then the forward migrations are applied.
const lastDevelopmentVersion = '20261012075338';

type Compat = { version: string; name: string; sha256: string; required_before: string };

describe('Upgrade from the Development migration history', () => {
  let db: PGlite;
  let compat: Compat[];
  let names: string[];

  async function record(version: string) {
    const name = names.find((item) => item.startsWith(`${version}_`))!;
    const sql = await readFile(`supabase/migrations/${name}`, 'utf8');
    await db.query(
      `insert into supabase_migrations.schema_migrations(version,name,statements) values($1,$2,$3)`,
      [version, name.slice(15, -4), [sql]],
    );
  }

  async function preflight() {
    const sql = await readFile('supabase/tests/bootstrap-compat-preflight.sql', 'utf8');
    const results = await db.exec(sql);
    const rows = results.find((result) => result.fields.some((f) => f.name === 'check_name'))!
      .rows as { check_name: string; ok: boolean; detail: string }[];
    return Object.fromEntries(rows.map((row) => [row.check_name, row.ok]));
  }

  beforeAll(async () => {
    compat = JSON.parse(await readFile('supabase/migration-bootstrap-compat.json', 'utf8'))
      .migrations as Compat[];
    names = (await readdir('supabase/migrations')).filter((n) => n.endsWith('.sql')).sort();
    const through = names.findIndex((n) => n.startsWith(`${lastDevelopmentVersion}_`)) + 1;
    db = await database(through);
    // Reproduce the Development state: compatibility versions absent from the
    // history and an out-of-band pause trigger whose function discards rows.
    await db.query(`delete from supabase_migrations.schema_migrations where version = any($1)`, [
      compat.map((row) => row.version),
    ]);
    await db.exec(`
      create function private.plateform_dev_pause_audit_discard() returns trigger
        language plpgsql as $f$ begin return null; end $f$;
      drop trigger plateform_dev_pause_audit on public.audit_log;
      drop function private.plateform_legacy_audit_pause_noop();
      create trigger plateform_dev_pause_audit before insert on public.audit_log
        for each row execute function private.plateform_dev_pause_audit_discard();
      alter table public.audit_log disable trigger plateform_dev_pause_audit;
      insert into private.continuity_rehearsal_key default values;
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('lists exactly the two backdated compatibility migrations, pinned by hash', async () => {
    const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'))
      .migrations as { version: string; sha256: string }[];
    expect(compat.map((row) => row.version)).toEqual(['20261006100100', '20261012075300']);
    for (const row of compat) {
      expect(manifest.find((item) => item.version === row.version)?.sha256).toBe(row.sha256);
      expect(row.version < row.required_before).toBe(true);
      expect(row.required_before <= lastDevelopmentVersion).toBe(true);
    }
  });

  it('allows the metadata-only repair through the read-only preflight', async () => {
    const checks = await preflight();
    expect(checks).toMatchObject({
      history_contains_20261006100248: true,
      history_contains_20261012075338: true,
      compat_versions_not_yet_recorded: true,
      rehearsal_tables_present: true,
      rehearsal_tables_rls_enabled: true,
      rehearsal_tables_no_client_access: true,
      audit_pause_trigger_not_enabled: true,
      BOOTSTRAP_COMPAT_REPAIR_ALLOWED: true,
    });
  });

  it('refuses the repair while the pause trigger is enabled', async () => {
    await db.exec('alter table public.audit_log enable trigger plateform_dev_pause_audit');
    try {
      const checks = await preflight();
      expect(checks.audit_pause_trigger_not_enabled).toBe(false);
      expect(checks.BOOTSTRAP_COMPAT_REPAIR_ALLOWED).toBe(false);
    } finally {
      await db.exec('alter table public.audit_log disable trigger plateform_dev_pause_audit');
    }
  });

  it('records the compatibility versions, then applies forward migrations', async () => {
    for (const row of compat) await record(row.version);
    expect((await preflight()).compat_versions_not_yet_recorded).toBe(false);
    for (const name of names.filter((n) => n.slice(0, 14) > lastDevelopmentVersion)) {
      await db.exec(await readFile(`supabase/migrations/${name}`, 'utf8'));
      await record(name.slice(0, 14));
    }
    const history = await db.query<{ count: number }>(
      'select count(*)::int as count from supabase_migrations.schema_migrations',
    );
    expect(history.rows[0]!.count).toBe(names.length);
  });

  it('ends append-only: pause trigger and discard function gone, audit rows persist', async () => {
    const pause = await db.query(
      `select 1 from pg_trigger where tgname='plateform_dev_pause_audit'
       union all
       select 1 where to_regprocedure('private.plateform_dev_pause_audit_discard()') is not null`,
    );
    expect(pause.rows).toEqual([]);
    await db.exec(`insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,request_id,correlation_id)
      values(now(),'SYSTEM','UPGRADE_PROBE','test','INSERT','SUCCESS',gen_random_uuid(),gen_random_uuid())`);
    const probe = await db.query<{ count: number }>(
      `select count(*)::int as count from public.audit_log where action='UPGRADE_PROBE'`,
    );
    expect(probe.rows[0]!.count).toBe(1);
    const violations = await db.query<{ v: string[] }>(
      'select private.audit_append_only_violations(true) as v',
    );
    expect(violations.rows[0]!.v).toEqual([]);
    const key = await db.query<{ count: number }>(
      'select count(*)::int as count from private.continuity_rehearsal_key',
    );
    expect(key.rows[0]!.count).toBe(1);
  });
});
