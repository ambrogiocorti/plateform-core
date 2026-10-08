import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { DURABLE_PRIVATE_TABLES, durablePrivateStateSql } from './private-state.mjs';

async function run(command, args, sensitiveValues = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve();
      let safe = stderr;
      for (const value of sensitiveValues) if (value) safe = safe.replaceAll(value, '[REDACTED]');
      reject(new Error(`DATABASE_DUMP_FAILED:${code}:${safe.slice(0, 400)}`));
    });
  });
}

async function capture(command, args, sensitiveValues = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      let safe = stderr;
      for (const value of sensitiveValues) if (value) safe = safe.replaceAll(value, '[REDACTED]');
      reject(new Error(`DATABASE_QUERY_FAILED:${code}:${safe.slice(0, 400)}`));
    });
  });
}

const CONTINUITY_STATE_SQL = `select json_build_object(
  'auth_user_count',(select count(*) from auth.users),
  'migration_count',(select count(*) from supabase_migrations.schema_migrations),
  'migration_latest_version',(select max(version) from supabase_migrations.schema_migrations),
  'migration_aggregate_sha256',(select encode(digest(coalesce(string_agg(
    version||'|'||name||'|'||encode(digest(array_to_string(statements,E'\\n\\n'),'sha256'),'hex'),
    E'\\n' order by version
  ),''),'sha256'),'hex') from supabase_migrations.schema_migrations),
  'private_state',${durablePrivateStateSql()}
);`;

async function continuityState(config) {
  const output = await capture(
    config.psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.databaseUrl,
      '--command',
      CONTINUITY_STATE_SQL,
    ],
    [config.databaseUrl],
  );
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error('DATABASE_CONTINUITY_STATE_INVALID');
  }
  const result = {
    authUserCount: Number(parsed.auth_user_count),
    migrationCount: Number(parsed.migration_count),
    migrationLatestVersion: String(parsed.migration_latest_version ?? ''),
    migrationAggregateSha256: String(parsed.migration_aggregate_sha256 ?? ''),
    privateState: parsed.private_state,
  };
  if (
    !Number.isInteger(result.authUserCount) ||
    result.authUserCount < 0 ||
    !Number.isInteger(result.migrationCount) ||
    result.migrationCount < 0 ||
    !/^[0-9]{14}$/.test(result.migrationLatestVersion) ||
    !/^[0-9a-f]{64}$/.test(result.migrationAggregateSha256) ||
    !result.privateState ||
    !/^[0-9a-f]{64}$/.test(String(result.privateState.aggregate_sha256 ?? '')) ||
    Number(result.privateState.table_count) !== DURABLE_PRIVATE_TABLES.length ||
    !Number.isInteger(Number(result.privateState.row_count))
  )
    throw new Error('DATABASE_CONTINUITY_STATE_INVALID');
  return result;
}

async function assertNonEmpty(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 32) throw new Error('DATABASE_DUMP_EMPTY');
}

async function authUsersInCopy(path) {
  const input = createReadStream(path, { encoding: 'utf8', highWaterMark: 128 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let inUsers = false;
  let found = false;
  let count = 0;
  try {
    for await (const line of lines) {
      if (!inUsers && /^COPY\s+(?:"auth"\.|auth\.)(?:"users"|users)\s*\(/i.test(line)) {
        inUsers = true;
        found = true;
        continue;
      }
      if (inUsers) {
        if (line === '\\.') break;
        count += 1;
      }
    }
  } finally {
    lines.close();
  }
  return { found, count };
}

export async function dumpDatabase(config, directory) {
  const roles = join(directory, 'roles.sql');
  const schema = join(directory, 'schema.sql');
  const data = join(directory, 'data.sql');
  const historySchema = join(directory, 'history_schema.sql');
  const historyData = join(directory, 'history_data.sql');
  const base = ['db', 'dump', '--db-url', config.databaseUrl];
  const before = await continuityState(config);

  await run(config.supabaseCli, [...base, '-f', roles, '--role-only'], [config.databaseUrl]);
  await run(config.supabaseCli, [...base, '-f', schema], [config.databaseUrl]);
  await run(
    config.supabaseCli,
    [
      ...base,
      '-f',
      data,
      '--use-copy',
      '--data-only',
      '-x',
      'storage.buckets_vectors',
      '-x',
      'storage.vector_indexes',
    ],
    [config.databaseUrl],
  );
  await run(
    config.supabaseCli,
    [...base, '-f', historySchema, '--schema', 'supabase_migrations'],
    [config.databaseUrl],
  );
  await run(
    config.supabaseCli,
    [...base, '-f', historyData, '--use-copy', '--data-only', '--schema', 'supabase_migrations'],
    [config.databaseUrl],
  );

  await Promise.all([
    assertNonEmpty(roles),
    assertNonEmpty(schema),
    assertNonEmpty(data),
    assertNonEmpty(historySchema),
    assertNonEmpty(historyData),
  ]);

  // Current Supabase migration backups include Auth data in data.sql. Fail closed
  // if the CLI/version in use does not include auth.users, because such a backup
  // cannot satisfy Plateform's recoverability contract.
  const authUsers = await authUsersInCopy(data);
  if (!authUsers.found) throw new Error('AUTH_DUMP_MISSING');
  const after = await continuityState(config);
  if (
    before.authUserCount !== after.authUserCount ||
    before.migrationCount !== after.migrationCount ||
    before.migrationLatestVersion !== after.migrationLatestVersion ||
    before.migrationAggregateSha256 !== after.migrationAggregateSha256 ||
    before.privateState.aggregate_sha256 !== after.privateState.aggregate_sha256 ||
    Number(before.privateState.row_count) !== Number(after.privateState.row_count)
  )
    throw new Error('DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP');
  if (authUsers.count !== after.authUserCount) throw new Error('AUTH_DUMP_COUNT_MISMATCH');

  return {
    roles,
    schema,
    data,
    historySchema,
    historyData,
    migrationCount: after.migrationCount,
    migrationLatestVersion: after.migrationLatestVersion,
    migrationAggregateSha256: after.migrationAggregateSha256,
    authIncluded: true,
    authUserCount: authUsers.count,
    authSource: 'data.sql',
    privateState: after.privateState,
  };
}
