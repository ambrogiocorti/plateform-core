#!/usr/bin/env node
/**
 * Plateform continuity/capacity preflight. Read-only by design.
 * No DDL, data deletion, cron manipulation, or backup scheduling.
 *
 * SUPABASE_DB_URL=... PLATEFORM_DB_CAPACITY_BYTES=500000000 \
 *   node scripts/continuity-capacity-preflight.mjs
 * node scripts/continuity-capacity-preflight.mjs --self-test
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SQL = [
  'select row_to_json(m)::text from (',
  'select clock_timestamp() checked_at, pg_database_size(current_database()) database_bytes,',
  '(select count(*) from supabase_migrations.schema_migrations) migration_count,',
  '(select count(*) from private.continuity_rehearsal_snapshot_manifest) snapshots,',
  '(select count(*) from private.continuity_rehearsal_snapshot_manifest',
  " where created_at >= now() - interval '24 hours') snapshots_last_24h,",
  '(select max(created_at) from private.continuity_rehearsal_snapshot_manifest) latest_snapshot_at,',
  "pg_total_relation_size('private.continuity_rehearsal_snapshot_rows'::regclass) snapshot_relation_bytes,",
  "pg_total_relation_size('private.continuity_rehearsal_transfer_chunks'::regclass) transfer_relation_bytes,",
  '(select max(completed_at) from public.backup_metadata',
  " where status = 'SUCCEEDED' and integrity_verified = true",
  ' and artifacts_purged_at is null) last_verified_backup_at,',
  '(select count(*) from public.backup_metadata',
  " where status in ('QUEUED', 'RUNNING')) backup_jobs_active,",
  '(select count(*) from public.backup_metadata',
  " where status = 'FAILED'",
  " and created_at >= now() - interval '24 hours') backup_failures_last_24h,",
  '(select coalesce(bool_or(active), false) from cron.job',
  " where command like '%enqueue_due_backup()%') backup_enqueue_enabled",
  ') m;',
].join('\n');

function natural(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_METRIC:' + name);
  return n;
}

export function assessCapacity(state, options) {
  const limit = natural(options.capacityBytes, 'capacityBytes');
  const backupLimit = natural(options.backupMaxAgeHours ?? 24, 'backupMaxAgeHours');
  if (!limit || !backupLimit) throw new Error('CAPACITY_CONFIGURATION_REQUIRED');
  const bytes = natural(state.database_bytes, 'database_bytes');
  const measured = Date.parse(state.checked_at);
  const lastBackup = state.last_verified_backup_at
    ? Date.parse(state.last_verified_backup_at)
    : null;
  if (!Number.isFinite(measured)) throw new Error('INVALID_METRIC:checked_at');
  if (lastBackup !== null && (!Number.isFinite(lastBackup) || lastBackup > measured)) {
    throw new Error('INVALID_METRIC:last_verified_backup_at');
  }
  const hoursSinceBackup = lastBackup === null ? null : (measured - lastBackup) / 3_600_000;
  const ratio = bytes / limit;
  const critical = [];
  const warnings = [];
  if (ratio >= 1) critical.push('DATABASE_OVER_CAPACITY');
  else if (ratio >= 0.8) warnings.push('DATABASE_ABOVE_80_PERCENT');
  if (hoursSinceBackup === null) critical.push('NO_VERIFIED_BACKUP');
  else if (hoursSinceBackup > backupLimit) critical.push('BACKUP_TOO_OLD');
  if (natural(state.backup_failures_last_24h, 'backup_failures_last_24h') > 0) {
    warnings.push('BACKUP_FAILURES_24H');
  }
  if (ratio >= 0.8 && natural(state.snapshots_last_24h, 'snapshots_last_24h') > 0) {
    warnings.push('REHEARSAL_SNAPSHOTS_NEAR_CAPACITY');
  }
  return {
    status: critical.length ? 'CRITICAL' : warnings.length ? 'WARNING' : 'OK',
    checked_at: state.checked_at,
    database_bytes: bytes,
    capacity_bytes: limit,
    utilization_percent: Number((ratio * 100).toFixed(2)),
    migrations: natural(state.migration_count, 'migration_count'),
    rehearsal: {
      snapshots: natural(state.snapshots, 'snapshots'),
      snapshots_last_24h: natural(state.snapshots_last_24h, 'snapshots_last_24h'),
      last_at: state.latest_snapshot_at,
      snapshot_relation_bytes: natural(state.snapshot_relation_bytes, 'snapshot_relation_bytes'),
      transfer_relation_bytes: natural(state.transfer_relation_bytes, 'transfer_relation_bytes'),
    },
    backup: {
      last_verified_at: state.last_verified_backup_at,
      age_hours: hoursSinceBackup === null ? null : Number(hoursSinceBackup.toFixed(2)),
      failures_24h: natural(state.backup_failures_last_24h, 'backup_failures_last_24h'),
      active_jobs: natural(state.backup_jobs_active, 'backup_jobs_active'),
      enqueue_enabled: state.backup_enqueue_enabled === true,
    },
    critical,
    warnings,
    action: critical.length || warnings.length
      ? 'INVESTIGATE_WITHOUT_PURGING_RECOVERY_ARTIFACTS'
      : 'CONTINUE_MONITORING',
  };
}

function fetchMetrics() {
  const input = process.env.SUPABASE_DB_URL;
  if (!input) throw new Error('SUPABASE_DB_URL_REQUIRED');
  let uri;
  try {
    uri = new URL(input);
  } catch {
    throw new Error('INVALID_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(uri.protocol) ||
    !uri.hostname ||
    !uri.username ||
    !uri.password ||
    !uri.pathname.slice(1)
  ) {
    throw new Error('INVALID_DATABASE_URL');
  }
  const env = {
    ...process.env,
    PGPASSWORD: decodeURIComponent(uri.password),
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '15',
  };
  for (const key of [
    'SUPABASE_DB_URL',
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGUSER',
    'PGDATABASE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGPASSFILE',
  ]) {
    delete env[key];
  }
  const result = spawnSync(
    process.env.PSQL_BIN || 'psql',
    [
      '-X', '-w', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
      '-h', uri.hostname, '-p', uri.port || '5432',
      '-U', decodeURIComponent(uri.username),
      '-d', decodeURIComponent(uri.pathname.slice(1)),
      '-c', SQL,
    ],
    { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) {
    // Never echo libpq stderr or a connection string.
    throw new Error('CAPACITY_READ_ONLY_QUERY_FAILED');
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('CAPACITY_QUERY_INVALID_RESPONSE');
  }
}

function selfTest() {
  const state = {
    checked_at: '2026-10-11T06:00:00Z',
    database_bytes: 200_000_000,
    migration_count: 457,
    snapshots: 155,
    snapshots_last_24h: 0,
    latest_snapshot_at: '2026-10-10T08:55:01Z',
    snapshot_relation_bytes: 100_000,
    transfer_relation_bytes: 10_000,
    last_verified_backup_at: '2026-10-11T05:00:00Z',
    backup_failures_last_24h: 0,
    backup_jobs_active: 0,
    backup_enqueue_enabled: false,
  };
  const options = { capacityBytes: 500_000_000 };
  assert.equal(assessCapacity(state, options).status, 'OK');
  assert.equal(assessCapacity({ ...state, database_bytes: 450_000_000 }, options).status, 'WARNING');
  assert.ok(assessCapacity({ ...state, database_bytes: 600_000_000 }, options).critical.includes('DATABASE_OVER_CAPACITY'));
  assert.ok(assessCapacity({ ...state, last_verified_backup_at: null }, options).critical.includes('NO_VERIFIED_BACKUP'));
  assert.ok(assessCapacity({ ...state, last_verified_backup_at: '2026-10-09T05:00:00Z' }, options).critical.includes('BACKUP_TOO_OLD'));
  assert.ok(assessCapacity({ ...state, database_bytes: 450_000_000, snapshots_last_24h: 10 }, options).warnings.includes('REHEARSAL_SNAPSHOTS_NEAR_CAPACITY'));
  assert.throws(() => assessCapacity(state, { capacityBytes: 0 }), /CAPACITY_CONFIGURATION_REQUIRED/);
  assert.throws(() => assessCapacity({ ...state, database_bytes: -1 }, options), /INVALID_METRIC/);
  console.log('CONTINUITY_CAPACITY_SELF_TEST=PASS (8/8)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--self-test') selfTest();
  else if (process.argv.length !== 2) throw new Error('USAGE: --self-test or no arguments');
  else {
    try {
      const report = assessCapacity(fetchMetrics(), {
        capacityBytes: process.env.PLATEFORM_DB_CAPACITY_BYTES,
        backupMaxAgeHours: process.env.PLATEFORM_BACKUP_MAX_AGE_HOURS || 24,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.status === 'CRITICAL') process.exitCode = 2;
      else if (report.status === 'WARNING') process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ status: 'BLOCKED', error_code: error.message }));
      process.exitCode = 2;
    }
  }
}
