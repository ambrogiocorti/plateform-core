#!/usr/bin/env node
// Read-only, fail-closed staging gate. A green isolated test suite cannot
// replace operational evidence from the actual hosted installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function classifyHostedReadiness(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('INVALID_HOSTED_READINESS_REPORT');
  const reasons = [];
  const continuity = report.continuity;
  if (!continuity || typeof continuity !== 'object' || Array.isArray(continuity))
    throw new Error('INVALID_HOSTED_CONTINUITY_REPORT');

  if (continuity.active_backups !== 0) reasons.push('BACKUPS_STILL_QUEUED_OR_RUNNING');
  if (!(continuity.usable_verified_backups > 0)) reasons.push('VERIFIED_BACKUP_MISSING');
  if (!(continuity.successful_restore_tests > 0)) reasons.push('RESTORE_TEST_MISSING');
  if (continuity.active_incidents !== 0) reasons.push('ACTIVE_INCIDENTS');
  if (!(continuity.required_cron_jobs_active >= 5)) reasons.push('REQUIRED_CRON_INACTIVE');
  if (report.database?.ok !== true) reasons.push('DATABASE_REGRESSION_GATE_BLOCKED');
  if (report.security?.ok !== true) reasons.push('SECURITY_GATE_BLOCKED');
  if (report.tests?.ok !== true) reasons.push('TEST_GATE_BLOCKED');
  if (report.health?.core_ok !== true) reasons.push('CORE_HEALTH_BLOCKED');
  if (report.manual_required_pending !== 0) reasons.push('MANUAL_ACCEPTANCE_PENDING');
  if (report.internal_ready !== true) reasons.push('INTERNAL_READINESS_BLOCKED');
  if (report.go_live_ready !== true) reasons.push('GO_LIVE_NOT_APPROVED');

  return { passed: reasons.length === 0, reasons };
}

export function safeStagingConnection(value, expectedRef) {
  if (!/^[a-z0-9]{20}$/.test(expectedRef ?? ''))
    throw new Error('EXPECTED_STAGING_PROJECT_REF_REQUIRED');
  if (!value) throw new Error('STAGING_DATABASE_URL_MISSING');
  let uri;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('STAGING_DATABASE_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(uri.protocol) ||
    !uri.hostname ||
    !uri.username ||
    !uri.password ||
    !uri.pathname.slice(1) ||
    (uri.port && (!/^\d+$/.test(uri.port) || Number(uri.port) > 65535))
  )
    throw new Error('STAGING_DATABASE_URL_INVALID');
  const username = decodeURIComponent(uri.username);
  const projectMatches =
    (uri.hostname === `db.${expectedRef}.supabase.co` && username === 'postgres') ||
    (uri.hostname.endsWith('.pooler.supabase.com') && username === `postgres.${expectedRef}`);
  if (!projectMatches) throw new Error('STAGING_PROJECT_REF_MISMATCH');
  return {
    host: uri.hostname,
    port: uri.port || '5432',
    username,
    password: decodeURIComponent(uri.password),
    database: decodeURIComponent(uri.pathname.slice(1)),
  };
}

function runSelfTest() {
  const full = {
    internal_ready: true,
    go_live_ready: true,
    database: { ok: true },
    security: { ok: true },
    tests: { ok: true },
    health: { core_ok: true },
    manual_required_pending: 0,
    continuity: {
      active_backups: 0,
      usable_verified_backups: 1,
      successful_restore_tests: 1,
      active_incidents: 0,
      required_cron_jobs_active: 5,
    },
  };
  assert.deepEqual(classifyHostedReadiness(full), { passed: true, reasons: [] });
  const blocked = classifyHostedReadiness({
    ...full,
    internal_ready: false,
    go_live_ready: false,
    manual_required_pending: 11,
    database: { ok: false },
    continuity: {
      ...full.continuity,
      active_backups: 1,
      usable_verified_backups: 0,
      successful_restore_tests: 0,
      active_incidents: 4,
      required_cron_jobs_active: 3,
    },
  });
  assert.equal(blocked.passed, false);
  for (const reason of [
    'BACKUPS_STILL_QUEUED_OR_RUNNING',
    'VERIFIED_BACKUP_MISSING',
    'RESTORE_TEST_MISSING',
    'REQUIRED_CRON_INACTIVE',
    'MANUAL_ACCEPTANCE_PENDING',
    'GO_LIVE_NOT_APPROVED',
  ])
    assert.ok(blocked.reasons.includes(reason), reason);
  assert.throws(() => classifyHostedReadiness({ go_live_ready: true }), /CONTINUITY/);
  assert.throws(() => safeStagingConnection('', 'qfgoatdabgnzozxuzxku'), /MISSING/);
  assert.throws(
    () =>
      safeStagingConnection(
        'postgresql://postgres:pass@db.xzateqavvaparjoybbhr.supabase.co/postgres',
        'qfgoatdabgnzozxuzxku',
      ),
    /PROJECT_REF_MISMATCH/,
  );
  assert.throws(
    () =>
      safeStagingConnection(
        'postgresql://postgres.qfgoatdabgnzozxuzxku:pass@untrusted.example/postgres',
        'qfgoatdabgnzozxuzxku',
      ),
    /PROJECT_REF_MISMATCH/,
  );
  assert.equal(
    safeStagingConnection(
      'postgresql://postgres.qfgoatdabgnzozxuzxku:pass@aws-0-eu-west-1.pooler.supabase.com/postgres',
      'qfgoatdabgnzozxuzxku',
    ).username,
    'postgres.qfgoatdabgnzozxuzxku',
  );
  console.log('HOSTED_RELEASE_READINESS_SELF_TEST=PASSED');
}

export function checkHostedStaging() {
  if (process.env.PLATEFORM_TARGET_ENV !== 'staging')
    throw new Error('STAGING_ENVIRONMENT_REQUIRED');
  const config = safeStagingConnection(
    process.env.SUPABASE_DB_URL,
    process.env.PLATEFORM_EXPECTED_PROJECT_REF,
  );
  const env = { ...process.env, PGPASSWORD: config.password, PGSSLMODE: 'require' };
  for (const key of [
    'SUPABASE_DB_URL',
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGUSER',
    'PGDATABASE',
    'PGPASSFILE',
    'PGSERVICE',
    'PGSERVICEFILE',
  ])
    delete env[key];
  const result = spawnSync(
    process.env.PSQL_BIN || 'psql',
    [
      '-X',
      '-w',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--host',
      config.host,
      '--port',
      config.port,
      '--username',
      config.username,
      '--dbname',
      config.database,
      '--command',
      'select public.release_readiness_report()::text',
    ],
    { env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  // Never print stderr or a database URL: both can contain account data.
  if (result.error || result.status !== 0) throw new Error('HOSTED_READINESS_QUERY_FAILED');
  let report;
  try {
    report = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('HOSTED_READINESS_INVALID_JSON');
  }
  const verdict = classifyHostedReadiness(report);
  console.log('HOSTED_STAGING_RELEASE_GATE=' + JSON.stringify(verdict));
  if (!verdict.passed) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') runSelfTest();
  else if (process.argv.length === 2) checkHostedStaging();
  else throw new Error('USAGE: --self-test or no arguments with staging environment');
}
