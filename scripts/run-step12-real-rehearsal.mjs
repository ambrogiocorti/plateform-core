import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const evidencePath = 'docs/evidence/step12-real-rehearsal-2026-10-06.json';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    timeout: options.timeout ?? 15 * 60_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error,
  };
}

function parseLastJson(text, code) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  throw new Error(code);
}

function fail(stage, details, exitCode = 2) {
  console.error(JSON.stringify({ status: 'BLOCKED', stage, ...details }, null, 2));
  process.exit(exitCode);
}

function psqlJson(sql) {
  const psql = process.env.PSQL_BIN?.trim() || 'psql';
  const databaseUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!databaseUrl) throw new Error('ENV_MISSING:SUPABASE_DB_URL');
  const result = run(
    psql,
    ['-X', '-A', '-t', '--set', 'ON_ERROR_STOP=1', '--dbname', databaseUrl, '--command', sql],
    { timeout: 60_000 },
  );
  if (result.error || result.status !== 0) throw new Error('SOURCE_DATABASE_QUERY_FAILED');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('SOURCE_DATABASE_QUERY_INVALID');
  }
}

const host = run(process.execPath, ['scripts/check-continuity-host.mjs']);
if (host.error || host.status !== 0) {
  let doctor = null;
  try {
    doctor = parseLastJson(host.stdout, 'HOST_CHECK_OUTPUT_INVALID');
  } catch {
    doctor = { stderr: host.stderr.slice(0, 400) };
  }
  fail('HOST_PREFLIGHT', { doctor });
}

const backupCheck = run(process.execPath, ['tools/backup-worker/start.mjs', '--check']);
if (backupCheck.error || backupCheck.status !== 0)
  fail('BACKUP_PREFLIGHT', { stderr: backupCheck.stderr.slice(0, 400) });

const backupRun = run(process.execPath, ['tools/backup-worker/start.mjs', '--once']);
if (backupRun.error || backupRun.status !== 0)
  fail('BACKUP_EXECUTION', { stderr: backupRun.stderr.slice(0, 400) });
const backupOutput = parseLastJson(backupRun.stdout, 'BACKUP_OUTPUT_INVALID');
if (!['SUCCEEDED', 'IDLE'].includes(backupOutput.status))
  fail('BACKUP_EXECUTION', { output: backupOutput });

const backupState = psqlJson(`select row_to_json(x) from (
  select id,status,integrity_verified,encryption_key_id,schema_version,manifest,verification,
         completed_at,last_restore_test_at,artifacts_purged_at
  from public.backup_metadata
  where status='SUCCEEDED' and integrity_verified and artifacts_purged_at is null
  order by completed_at desc,id desc limit 1
) x;`);
if (!backupState?.id) fail('REAL_BACKUP_REQUIRED', { reason: 'NO_VERIFIED_BACKUP' });

const migrationState = psqlJson(`select json_build_object(
  'count',count(*),
  'latest_version',max(version),
  'aggregate_sha256',encode(digest(coalesce(string_agg(
    version||'|'||name||'|'||encode(digest(array_to_string(statements,E'\\n\\n'),'sha256'),'hex'),
    E'\\n' order by version
  ),''),'sha256'),'hex')
) from supabase_migrations.schema_migrations;`);
const targets = psqlJson(`select json_build_object(
  'rpo_target_minutes',rpo_target_minutes,
  'rto_target_minutes',rto_target_minutes
) from private.continuity_settings where id;`);

const verification = backupState.verification ?? {};
const backupValid =
  backupState.status === 'SUCCEEDED' &&
  backupState.integrity_verified === true &&
  typeof backupState.encryption_key_id === 'string' &&
  verification.database === true &&
  verification.migrations === true &&
  verification.auth === true &&
  verification.storage === true &&
  verification.storage_metadata === true &&
  verification.private_state === true &&
  verification.replica === true &&
  verification.manifest_auth === true;
if (!backupValid) fail('REAL_BACKUP_REQUIRED', { reason: 'BACKUP_VERIFICATION_INCOMPLETE' });

const restoreCheck = run(process.execPath, ['tools/restore-test-worker/start.mjs', '--check']);
if (restoreCheck.error || restoreCheck.status !== 0) {
  fail('RESTORE_TEST_PREFLIGHT', {
    backup_id: backupState.id,
    instruction: 'Activate/configure the disposable restore target, then rerun this command.',
    stderr: restoreCheck.stderr.slice(0, 400),
  });
}
const restoreReady = parseLastJson(restoreCheck.stdout, 'RESTORE_TEST_CHECK_OUTPUT_INVALID');

const restoreRun = run(process.execPath, ['tools/restore-test-worker/start.mjs', '--once']);
if (restoreRun.error || restoreRun.status !== 0)
  fail('RESTORE_TEST_EXECUTION', { stderr: restoreRun.stderr.slice(0, 400) });
const restoreOutput = parseLastJson(restoreRun.stdout, 'RESTORE_TEST_OUTPUT_INVALID');
if (restoreOutput.status === 'IDLE') {
  fail(
    'RESTORE_TEST_REQUEST_REQUIRED',
    {
      backup_id: backupState.id,
      instruction:
        'From the Super Admin backup/restore UI, request an isolated restore test for this backup with step-up, then rerun the same command.',
    },
    3,
  );
}
if (restoreOutput.status !== 'SUCCEEDED')
  fail('RESTORE_TEST_EXECUTION', { output: restoreOutput });

const rv = restoreOutput.verification ?? {};
const evidence = {
  date: new Date().toISOString(),
  status: 'PASSED',
  source_project_ref: process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i)?.[1] ?? null,
  source_state: 'REACHABLE_VERIFIED',
  target_project_ref: restoreOutput.target ?? restoreReady.targetProjectRef ?? null,
  target_project_name: 'plateform-restore-test',
  target_state: 'REACHABLE_VERIFIED',
  target_reachable_verified: true,
  source_migrations: {
    count: Number(migrationState.count),
    latest_version: String(migrationState.latest_version ?? ''),
    aggregate_sha256: String(migrationState.aggregate_sha256 ?? ''),
  },
  backup: {
    id: backupState.id,
    status: backupState.status,
    integrity_verified: backupState.integrity_verified === true,
    encrypted: Boolean(backupState.encryption_key_id),
    manifest_hmac_verified: verification.manifest_auth === true,
    primary_replica_verified: verification.replica === true,
    schema_version: backupState.schema_version,
    encryption_key_id: backupState.encryption_key_id,
  },
  restore_test: {
    status: restoreOutput.status,
    migration_count: Number(rv.migration_count),
    migration_latest_version: String(rv.migration_latest_version ?? ''),
    migration_aggregate_sha256: String(rv.migration_hash ?? rv.migration_aggregate_sha256 ?? ''),
    database_verified: rv.database === true,
    auth_verified: rv.auth === true,
    storage_verified: rv.storage === true && rv.storage_metadata === true,
    private_state_verified: rv.private_state === true,
    rls_verified: rv.rls === true,
    sessions_invalidated: rv.sessions === true && rv.devices === true,
  },
  documented_rpo_minutes: Number(targets.rpo_target_minutes),
  documented_rto_minutes: Number(targets.rto_target_minutes),
  observed_rpo_minutes: null,
  observed_rto_minutes: null,
  cutover_rehearsal: 'STEP13_GO_LIVE',
  blocking_reason: null,
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

const gate = run(process.execPath, ['scripts/check-step12-real-rehearsal.mjs']);
if (gate.error || gate.status !== 0)
  fail('FINAL_CERTIFICATION_GATE', { stderr: gate.stderr.slice(0, 800) });
console.log(JSON.stringify({ status: 'PASSED', backup_id: backupState.id, target: evidence.target_project_ref }, null, 2));
