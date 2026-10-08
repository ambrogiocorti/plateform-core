import { spawn } from 'node:child_process';
import {
  DURABLE_PRIVATE_TABLES,
  durablePrivateStateSql,
  securityStateSql,
  sanitizeSecuritySql,
} from '../backup-worker/private-state.mjs';

function run(command, args, secrets = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      let safe = stderr;
      for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[REDACTED]');
      reject(new Error(`RESTORE_DATABASE_FAILED:${code}:${safe.slice(0, 400)}`));
    });
  });
}

export async function restoreDatabase(config, files) {
  // Match Supabase's documented logical restore sequence. Auth data and Storage
  // metadata are already part of data.sql; Storage object bytes are restored later.
  await run(
    config.psql,
    [
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--file',
      files.roles,
      '--file',
      files.schema,
      '--command',
      'SET session_replication_role = replica',
      '--file',
      files.data,
      '--dbname',
      config.targetDatabaseUrl,
    ],
    [config.targetDatabaseUrl],
  );
  await run(
    config.psql,
    [
      '--single-transaction',
      '--variable',
      'ON_ERROR_STOP=1',
      '--file',
      files.historySchema,
      '--file',
      files.historyData,
      '--dbname',
      config.targetDatabaseUrl,
    ],
    [config.targetDatabaseUrl],
  );
}

export async function verifyDatabase(config) {
  const sql = `select json_build_object(
    'database',true,
    'auth',to_regclass('auth.users') is not null,
    'auth_user_count',(select count(*) from auth.users),
    'rls',not exists(
      select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
    ),
    'accounts',to_regclass('public.accounts') is not null,
    'payments',to_regclass('public.payments') is not null,
    'audit',to_regclass('public.audit_log') is not null,
    'sessions',to_regclass('auth.sessions') is not null,
    'devices',to_regclass('public.registered_devices') is not null
  );`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_DATABASE_VERIFICATION_INVALID');
  }
}

export async function verifyMigrationHistory(config, expected) {
  if (
    !expected ||
    !Number.isInteger(expected.count) ||
    expected.count < 0 ||
    !/^[0-9]{14}$/.test(String(expected.latest_version ?? '')) ||
    !/^[0-9a-f]{64}$/.test(String(expected.aggregate_sha256 ?? ''))
  )
    throw new Error('RESTORE_MIGRATION_MANIFEST_INVALID');
  const sql = `select json_build_object(
    'count',count(*),
    'latest_version',max(version),
    'aggregate_sha256',encode(digest(coalesce(string_agg(
      version||'|'||name||'|'||encode(digest(array_to_string(statements,E'\\n\\n'),'sha256'),'hex'),
      E'\\n' order by version
    ),''),'sha256'),'hex')
  ) from supabase_migrations.schema_migrations;`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  let actual;
  try {
    actual = JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_MIGRATION_VERIFICATION_INVALID');
  }
  const count = Number(actual.count);
  const latestVersion = String(actual.latest_version ?? '');
  const aggregateSha256 = String(actual.aggregate_sha256 ?? '');
  return {
    migrations:
      count === expected.count &&
      latestVersion === expected.latest_version &&
      aggregateSha256 === expected.aggregate_sha256,
    migration_count: count,
    migration_latest_version: latestVersion,
    migration_hash: aggregateSha256,
  };
}

export async function quiesceTargetAutomation(config) {
  const sql = `do $$
declare r record;
begin
  if to_regclass('cron.job') is not null then
    for r in select jobname from cron.job where jobname like 'plateform-%' loop
      perform cron.unschedule(r.jobname);
    end loop;
  end if;
exception when undefined_function or undefined_table then null;
end $$;`;
  await run(
    config.psql,
    ['-X', '--set', 'ON_ERROR_STOP=1', '--dbname', config.targetDatabaseUrl, '--command', sql],
    [config.targetDatabaseUrl],
  );
}

export async function sanitizeRestoredSecurityState(config) {
  await run(
    config.psql,
    [
      '-X',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sanitizeSecuritySql(),
    ],
    [config.targetDatabaseUrl],
  );
}

export async function verifyPrivateState(config, expected) {
  if (
    !expected ||
    expected.policy !== 'durable-private-v1' ||
    expected.security_sanitization !== 'invalidate-runtime-security-state-v1' ||
    !Number.isInteger(Number(expected.durable_table_count)) ||
    Number(expected.durable_table_count) !== DURABLE_PRIVATE_TABLES.length ||
    !Number.isInteger(Number(expected.durable_row_count)) ||
    Number(expected.durable_row_count) < 0 ||
    !/^[0-9a-f]{64}$/.test(String(expected.durable_aggregate_sha256 ?? ''))
  )
    throw new Error('RESTORE_PRIVATE_STATE_MANIFEST_INVALID');
  const sql = `select json_build_object('durable',${durablePrivateStateSql()},'security',${securityStateSql()});`;
  const output = await run(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      sql,
    ],
    [config.targetDatabaseUrl],
  );
  let actual;
  try {
    actual = JSON.parse(output.trim());
  } catch {
    throw new Error('RESTORE_PRIVATE_STATE_VERIFICATION_INVALID');
  }
  const durable = actual?.durable ?? {};
  const security = actual?.security ?? {};
  const privateCounts = Array.isArray(security.private) ? security.private : [];
  const authCounts = Array.isArray(security.auth) ? security.auth : [];
  const sessionsSanitized = [...privateCounts, ...authCounts].every(
    (row) => Number(row?.count) === 0,
  );
  const stateOk =
    Number(durable.table_count) === Number(expected.durable_table_count) &&
    Number(durable.row_count) === Number(expected.durable_row_count) &&
    String(durable.aggregate_sha256 ?? '') === String(expected.durable_aggregate_sha256);
  return {
    private_state: stateOk,
    private_durable_rows: Number(durable.row_count ?? -1),
    private_durable_hash: String(durable.aggregate_sha256 ?? ''),
    sessions: sessionsSanitized,
  };
}
