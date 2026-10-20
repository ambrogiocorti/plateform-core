import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { database, identity, ids, seed } from './harness';

// PGlite runs as a superuser. Event triggers and ENABLE ALWAYS guards are
// exercised for real; hosted Supabase privileges still need a live check.
describe('Append-only audit log (Macro-step A.1)', () => {
  let db: PGlite;
  let partitions: string[];
  beforeAll(async () => {
    db = await database();
    await seed(db);
    partitions = (
      await db.query<{ name: string }>(
        `select 'public.'||relid::regclass::text as name from pg_partition_tree('public.audit_log'::regclass) where isleaf order by 1`,
      )
    ).rows.map((row) => row.name);
    // One fixture row per partition, so row-level guards actually fire.
    await db.exec(`insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,request_id,correlation_id)
      select date_trunc('month',now())+make_interval(months=>n)+interval '1 day','SYSTEM','A1_PARTITION_FIXTURE',
        'test','INSERT','SUCCESS',gen_random_uuid(),gen_random_uuid()
      from generate_series(0,4) n`);
  });
  afterAll(async () => {
    await db?.close();
  });

  async function violations(full = true) {
    return (
      await db.query<{ v: string[] }>('select private.audit_append_only_violations($1) as v', [
        full,
      ])
    ).rows[0]!.v;
  }

  it('removes every legacy pause trigger and its function', async () => {
    const triggers = await db.query(
      `select tgrelid::regclass::text from pg_trigger where tgname='plateform_dev_pause_audit'`,
    );
    expect(triggers.rows).toEqual([]);
    const fn = await db.query(
      `select to_regprocedure('private.plateform_legacy_audit_pause_noop()') is null as gone`,
    );
    expect(fn.rows).toEqual([{ gone: true }]);
  });

  it('reports no append-only violation after a clean replay', async () => {
    expect(partitions.length).toBeGreaterThanOrEqual(2);
    expect(await violations(true)).toEqual([]);
  });

  it('passes the recovered non-destructive capture smoke script', async () => {
    const before = await db.query<{ count: number }>(
      'select count(*)::int as count from public.audit_log',
    );
    await db.exec(await readFile('supabase/tests/audit-capture-smoke.sql', 'utf8'));
    const after = await db.query<{ count: number }>(
      'select count(*)::int as count from public.audit_log',
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('still appends audit events through the server-side writer', async () => {
    await db.query("select private.audit('A1_APPEND_ONLY_PROBE','test',null,null)");
    const rows = await db.query<{ count: number }>(
      "select count(*)::int as count from public.audit_log where action='A1_APPEND_ONLY_PROBE'",
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it('rejects TRUNCATE, UPDATE and DELETE on every partition, even for the owner', async () => {
    for (const table of partitions) {
      await expect(db.exec(`truncate ${table}`)).rejects.toThrow('IMMUTABLE_RECORD');
      await expect(db.exec(`update ${table} set action='FORGED'`)).rejects.toThrow(
        'IMMUTABLE_RECORD',
      );
      await expect(db.exec(`delete from ${table}`)).rejects.toThrow('IMMUTABLE_RECORD');
    }
  });

  it('keeps guards active under session_replication_role=replica', async () => {
    await db.exec('begin; set local session_replication_role=replica');
    try {
      await expect(db.exec(`update public.audit_log set action='FORGED'`)).rejects.toThrow(
        'IMMUTABLE_RECORD',
      );
    } finally {
      await db.exec('rollback');
    }
    await db.exec('begin; set local session_replication_role=replica');
    try {
      await expect(db.exec(`truncate ${partitions[0]}`)).rejects.toThrow('IMMUTABLE_RECORD');
    } finally {
      await db.exec('rollback');
    }
  });

  it('denies service_role mutation and trigger creation on partitions', async () => {
    const table = partitions.find((name) => name !== 'public.audit_log_default')!;
    for (const sql of [
      `truncate ${table}`,
      `update ${table} set action='FORGED'`,
      `delete from ${table}`,
      `create trigger discard before insert on ${table} for each row execute function private.immutable_record()`,
    ]) {
      await db.exec('set role service_role');
      try {
        await expect(db.exec(sql)).rejects.toThrow(/permission denied|must be owner/);
      } finally {
        await db.exec('reset role');
      }
    }
  });

  it('rejects DDL that would disable, drop, detach or bypass the guards', async () => {
    await db.exec(`create function private.a1_discard() returns trigger language plpgsql
      set search_path='' as $$ begin return null; end $$`);
    const table = partitions.find((name) => name !== 'public.audit_log_default')!;
    const attempts: [string, RegExp][] = [
      [
        'alter table public.audit_log disable trigger audit_immutable',
        /AUDIT_APPEND_ONLY_VIOLATION/,
      ],
      [
        'alter table public.audit_log enable replica trigger audit_immutable',
        /AUDIT_APPEND_ONLY_VIOLATION/,
      ],
      [`alter table ${table} disable trigger audit_no_truncate`, /AUDIT_APPEND_ONLY_VIOLATION/],
      [
        'create trigger discard before insert on public.audit_log for each row execute function private.a1_discard()',
        /AUDIT_APPEND_ONLY_VIOLATION/,
      ],
      [
        `create trigger discard before insert on ${table} for each row execute function private.a1_discard()`,
        /AUDIT_APPEND_ONLY_VIOLATION/,
      ],
      [
        'create rule discard as on insert to public.audit_log do instead nothing',
        /AUDIT_APPEND_ONLY_VIOLATION/,
      ],
      [`alter table public.audit_log detach partition ${table}`, /AUDIT_APPEND_ONLY_VIOLATION/],
      [`grant truncate on ${table} to service_role`, /AUDIT_APPEND_ONLY_VIOLATION/],
      ['grant trigger on public.audit_log to authenticated', /AUDIT_APPEND_ONLY_VIOLATION/],
      [`drop trigger audit_no_truncate on ${table}`, /AUDIT_APPEND_ONLY_DDL_REJECTED/],
      [`drop table ${table}`, /AUDIT_APPEND_ONLY_DDL_REJECTED/],
    ];
    for (const [sql, error] of attempts) await expect(db.exec(sql)).rejects.toThrow(error);
    await db.exec('drop function private.a1_discard()');
    expect(await violations(true)).toEqual([]);
  });

  it('detects tampering made while event triggers are bypassed', async () => {
    // Superusers can bypass event triggers in replica mode; the read-only
    // check (and the certification gate built on it) still reports it.
    await db.exec(`begin; set local session_replication_role=replica;
      alter table ${partitions[0]} disable trigger audit_no_truncate;
      grant truncate on ${partitions[0]} to service_role;`);
    try {
      const found = await violations(true);
      expect(found).toContain(`TRUNCATE_GUARD_MISSING_OR_DISABLED:${partitions[0]}`);
      expect(found).toContain(`PRIVILEGE:${partitions[0]}:service_role:TRUNCATE`);
      await expect(db.exec('select private.assert_audit_append_only()')).rejects.toThrow(
        'AUDIT_APPEND_ONLY_VIOLATION',
      );
    } finally {
      await db.exec('rollback');
    }
    expect(await violations(true)).toEqual([]);
  });

  it('guards partitions created by the monthly rotation', async () => {
    const created = await db.query<{ n: number }>(
      'select private.ensure_audit_monthly_partitions(8) as n',
    );
    expect(created.rows[0]!.n).toBeGreaterThan(0);
    const newest = (
      await db.query<{ name: string }>(
        `select 'public.'||relid::regclass::text as name from pg_partition_tree('public.audit_log'::regclass)
         where isleaf and relid<>'public.audit_log_default'::regclass order by 1 desc limit 1`,
      )
    ).rows[0]!.name;
    expect(partitions).not.toContain(newest);
    await expect(db.exec(`truncate ${newest}`)).rejects.toThrow('IMMUTABLE_RECORD');
    expect(await violations(true)).toEqual([]);
  });

  it('exposes the invariants in the SUPER_ADMIN certification gate', async () => {
    await db.exec('begin');
    try {
      // GoTrue owns auth.audit_log_entries on Supabase; empty shape-only fixture.
      await db.exec('create table auth.audit_log_entries(id uuid primary key)');
      await identity(db, ids.superAdmin);
      const gate = (
        await db.query<{
          g: { append_only_violations: string[]; ddl_guard_installed: boolean; reasons: string[] };
        }>('select public.get_audit_certification_gates() as g')
      ).rows[0]!.g;
      expect(gate.append_only_violations).toEqual([]);
      expect(gate.ddl_guard_installed).toBe(true);
      expect(gate.reasons).not.toContain('AUDIT_APPEND_ONLY_GUARD_VIOLATED');
      expect(gate.reasons).not.toContain('AUDIT_DDL_GUARD_NOT_INSTALLED');
    } finally {
      await db.exec('rollback; reset role');
    }
  });
  it('counts a recovery proof ending on an earlier batch of the current chain', async () => {
    const chain = (n: number) => String(n).repeat(64);
    const current = async () => {
      await identity(db, ids.superAdmin);
      const gate = (
        await db.query<{ g: { archive_recovery_current: boolean } }>(
          'select public.get_audit_certification_gates() as g',
        )
      ).rows[0]!.g;
      await db.exec('reset role');
      return gate.archive_recovery_current;
    };
    await db.exec('begin');
    try {
      await db.exec('create table auth.audit_log_entries(id uuid primary key)');
      for (const n of [1, 2]) {
        await db.query(
          `insert into private.audit_archive_batches(batch_no,starting_at,starting_id,ending_at,ending_id,row_count,
             payload_sha256,plaintext_sha256,previous_chain_sha256,chain_sha256,object_path)
           values($1,now(),gen_random_uuid(),now(),gen_random_uuid(),10,$2,$2,$3,$4,$5)`,
          [n, 'a'.repeat(64), n === 1 ? '0'.repeat(64) : chain(1), chain(n), `v1/batch-${n}.bin`],
        );
      }
      await db.query(
        'update private.audit_archive_cursor set last_batch=2,last_chain_sha256=$1 where id',
        [chain(2)],
      );
      // Verified up to batch 1; batch 2 was sealed afterwards on the same chain.
      await db.query(
        "insert into private.audit_archive_verification_runs(result,checked_batches,checked_rows,final_chain_sha256) values('PASS',1,10,$1)",
        [chain(1)],
      );
      expect(await current()).toBe(true);
      // A proof whose chain matches no sealed batch is never current.
      await db.query(
        "insert into private.audit_archive_verification_runs(result,checked_batches,checked_rows,final_chain_sha256) values('PASS',1,10,$1)",
        [chain(9)],
      );
      expect(await current()).toBe(false);
    } finally {
      await db.exec('rollback; reset role');
    }
  });
});
