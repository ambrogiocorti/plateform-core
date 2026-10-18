// Replays the full migration chain on a LOCAL, disposable PostgreSQL server
// (PostgreSQL 16, like hosted Supabase) and simulates the upgrade of an
// existing installation whose history stops at the Development state.
//
// Safety: local socket or loopback only, a fresh randomly named database per
// scenario, dropped at the end (unless --keep). Never a linked project, never
// a connection string, never Supabase credentials.
//
//   node scripts/replay-migrations-postgres.mjs [--clean] [--upgrade] [--keep]
//
// Uses the `psql` client and the standard PGHOST/PGPORT/PGUSER variables.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const prefix = 'plateform_replay_';
const args = new Set(process.argv.slice(2));
const host = process.env.PGHOST ?? '';
const localHost =
  host === '' || host.startsWith('/') || ['localhost', '127.0.0.1', '::1'].includes(host);
assert.ok(localHost, 'LOCAL_POSTGRES_ONLY: PGHOST must be a socket directory or loopback');
for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_ACCESS_TOKEN', 'PGSERVICE'])
  assert.ok(!process.env[name], `REMOTE_DATABASE_CONFIGURATION_REFUSED: unset ${name}`);

function psql(database, sql, extra = []) {
  assert.ok(database === 'postgres' || database.startsWith(prefix), 'DISPOSABLE_DATABASE_ONLY');
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      'psql',
      ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database, ...extra, '-f', '-'],
      { env: { ...process.env, PGDATABASE: database, PGOPTIONS: '--client-min-messages=warning' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolveRun(stdout.trim()) : reject(new Error(stderr.trim().slice(-1200))),
    );
    child.stdin.end(sql);
  });
}

const query = (database, sql) => psql(database, sql, ['-A', '-t']);

function literal(text) {
  let tag = 'plateform';
  while (text.includes(`$${tag}$`)) tag = `plateform_${randomBytes(4).toString('hex')}`;
  return `$${tag}$${text}$${tag}$`;
}

const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8')).migrations;
const compat = JSON.parse(
  await readFile('supabase/migration-bootstrap-compat.json', 'utf8'),
).migrations;
const fixture = await readFile('supabase/tests/host-fixture.sql', 'utf8');
const files = (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
assert.deepEqual(
  files,
  manifest.map((row) => row.filename),
  'MIGRATION_INVENTORY_MISMATCH',
);

async function migrationSql(filename) {
  const sql = await readFile(`supabase/migrations/${filename}`, 'utf8');
  // pg_cron is host-provided on Supabase; host-fixture.sql reproduces its contract.
  return sql.replace(/^create extension if not exists pg_cron;\s*$/gim, '');
}

async function record(database, row) {
  const sql = await readFile(`supabase/migrations/${row.filename}`, 'utf8');
  await psql(
    database,
    `insert into supabase_migrations.schema_migrations(version,name,statements)
     values('${row.version}','${row.name}',array[${literal(sql)}]);`,
  );
}

async function apply(database, row) {
  try {
    await psql(database, await migrationSql(row.filename));
  } catch (error) {
    throw new Error(`MIGRATION_FAILED ${row.filename}: ${error.message}`, { cause: error });
  }
  await record(database, row);
}

async function createDatabase(label) {
  const database = `${prefix}${label}_${randomBytes(6).toString('hex')}`;
  await psql('postgres', `create database ${database};`);
  await psql(database, fixture);
  return database;
}

const created = [];
const evidence = {};

async function cleanReplay() {
  const database = await createDatabase('clean');
  created.push(database);
  const started = Date.now();
  for (const row of manifest) await apply(database, row);
  const count = Number(
    await query(database, 'select count(*) from supabase_migrations.schema_migrations;'),
  );
  assert.equal(count, manifest.length);
  const violations = await query(
    database,
    'select private.audit_append_only_violations(true)::text;',
  );
  assert.equal(violations, '{}', `AUDIT_APPEND_ONLY_VIOLATIONS ${violations}`);
  const pause = await query(
    database,
    `select count(*) from pg_trigger where tgname='plateform_dev_pause_audit';`,
  );
  assert.equal(pause, '0');
  evidence.clean = {
    migrations_applied: count,
    latest_version: manifest.at(-1).version,
    audit_append_only_violations: [],
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// The Development database applied 480 migrations, up to 20261012075338, without
// the two compatibility files: their objects had been created out of band and the
// pause trigger pointed at a function that discarded audit rows.
async function developmentLikeDatabase(label) {
  const database = await createDatabase(label);
  created.push(database);
  const compatVersions = new Set(compat.map((row) => row.version));
  const latestApplied = '20261012075338';
  for (const row of manifest.filter((item) => item.version <= latestApplied))
    await apply(database, row);
  await psql(
    database,
    `delete from supabase_migrations.schema_migrations
       where version in (${[...compatVersions].map((v) => `'${v}'`).join(',')});
     create function private.plateform_dev_pause_audit_discard() returns trigger
       language plpgsql as $f$ begin return null; end $f$;
     drop trigger plateform_dev_pause_audit on public.audit_log;
     drop function private.plateform_legacy_audit_pause_noop();
     create trigger plateform_dev_pause_audit before insert on public.audit_log
       for each row execute function private.plateform_dev_pause_audit_discard();
     alter table public.audit_log disable trigger plateform_dev_pause_audit;
     insert into private.continuity_rehearsal_key default values;`,
  );
  return database;
}

const fingerprintSql = `select md5(string_agg(item, '|' order by item)) from (
  select 'rel:'||c.oid::regclass||':'||c.relkind::text||':'||c.relrowsecurity||':'||coalesce(c.relacl::text,'')
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','storage','supabase_migrations')
  union all
  select 'col:'||a.attrelid::regclass||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and a.attnum>0 and not a.attisdropped
  union all
  select 'trg:'||t.tgrelid::regclass||':'||t.tgname||':'||t.tgenabled::text||':'||t.tgfoid::regprocedure
    from pg_trigger t
  union all
  select 'fn:'||p.oid::regprocedure||':'||md5(p.prosrc)||':'||coalesce(p.proacl::text,'')
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and p.proname <> 'plateform_legacy_audit_pause_noop'
  union all
  select 'pol:'||polrelid::regclass||':'||polname||':'||coalesce(pg_get_expr(polqual,polrelid),'')
    from pg_policy
) s(item);`;

async function finishUpgrade(database) {
  const pending = manifest.filter((row) => row.version > '20261012075338');
  for (const row of pending) await apply(database, row);
  const result = await query(
    database,
    `insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,request_id,correlation_id)
       values(now(),'SYSTEM','REPLAY_UPGRADE_PROBE','test','INSERT','SUCCESS',gen_random_uuid(),gen_random_uuid());
     select (select count(*) from public.audit_log where action='REPLAY_UPGRADE_PROBE')
       ||':'||(select count(*) from pg_trigger where tgname='plateform_dev_pause_audit')
       ||':'||(to_regprocedure('private.plateform_dev_pause_audit_discard()') is null)
       ||':'||private.audit_append_only_violations(true)::text
       ||':'||(select count(*) from supabase_migrations.schema_migrations);`,
  );
  assert.equal(result, `1:0:true:{}:${manifest.length}`, `UPGRADE_END_STATE ${result}`);
  return pending.map((row) => row.version);
}

async function upgradeWithRepair() {
  const database = await developmentLikeDatabase('repair');
  const preflight = await query(
    database,
    await readFile('supabase/tests/bootstrap-compat-preflight.sql', 'utf8'),
  );
  const verdict = preflight
    .split('\n')
    .find((line) => line.startsWith('BOOTSTRAP_COMPAT_REPAIR_ALLOWED|'));
  assert.ok(
    verdict?.startsWith('BOOTSTRAP_COMPAT_REPAIR_ALLOWED|t|'),
    `PREFLIGHT_FAILED\n${preflight}`,
  );
  const before = await query(database, fingerprintSql);
  // Equivalent of `supabase migration repair --status applied <version>`: history only.
  for (const entry of compat)
    await record(
      database,
      manifest.find((row) => row.version === entry.version),
    );
  assert.equal(await query(database, fingerprintSql), before, 'REPAIR_CHANGED_SCHEMA');
  const applied = await finishUpgrade(database);
  const keyRows = await query(database, 'select count(*) from private.continuity_rehearsal_key;');
  assert.equal(keyRows, '1', 'REHEARSAL_DATA_CHANGED');
  evidence.upgrade_with_repair = {
    preflight: 'BOOTSTRAP_COMPAT_REPAIR_ALLOWED=true',
    repaired_versions: compat.map((row) => row.version),
    schema_unchanged_by_repair: true,
    applied_after_repair: applied,
    audit_insert_persisted: true,
    pause_trigger_and_discard_function_removed: true,
  };
}

// What `supabase db push --include-all` would do: execute the backdated files out
// of order. Kept as evidence of their side effects; the documented path is repair.
async function upgradeWithIncludeAll() {
  const database = await developmentLikeDatabase('includeall');
  const before = await query(database, fingerprintSql);
  for (const entry of compat)
    await apply(
      database,
      manifest.find((row) => row.version === entry.version),
    );
  const schemaUnchanged = (await query(database, fingerprintSql)) === before;
  const pauseState = await query(
    database,
    `select tgenabled::text||':'||tgfoid::regprocedure from pg_trigger where tgname='plateform_dev_pause_audit' and tgrelid='public.audit_log'::regclass;`,
  );
  assert.equal(pauseState, 'D:private.plateform_dev_pause_audit_discard()');
  const applied = await finishUpgrade(database);
  evidence.upgrade_with_include_all = {
    executed_out_of_order: compat.map((row) => row.version),
    schema_fingerprint_unchanged: schemaUnchanged,
    pause_trigger_left_disabled: true,
    applied_after: applied,
  };
}

const all = !args.has('--clean') && !args.has('--upgrade');
try {
  evidence.server = await query('postgres', 'show server_version;');
  if (all || args.has('--clean')) await cleanReplay();
  if (all || args.has('--upgrade')) {
    await upgradeWithRepair();
    await upgradeWithIncludeAll();
  }
  console.log('POSTGRES_MIGRATION_REPLAY=PASSED');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (!args.has('--keep'))
    for (const database of created) await psql('postgres', `drop database if exists ${database};`);
}
