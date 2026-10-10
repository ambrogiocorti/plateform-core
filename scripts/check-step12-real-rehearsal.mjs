import { readFile } from 'node:fs/promises';

const migrationManifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
const evidenceArgIndex = process.argv.indexOf('--evidence');
const evidencePath =
  evidenceArgIndex >= 0
    ? process.argv[evidenceArgIndex + 1]
    : 'docs/evidence/step12-real-rehearsal-2026-10-06.json';
if (!evidencePath) throw new Error('EVIDENCE_PATH_REQUIRED');
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const liveBaseline = JSON.parse(
  await readFile('docs/evidence/step12-migration-sync-130-2026-10-06.json', 'utf8'),
);
const rows = migrationManifest.migrations;
const expectedCount = rows.length;
const expectedLatest = rows.at(-1)?.version;
const errors = [];
const require = (ok, code) => {
  if (!ok) errors.push(code);
};

require(evidence.source_project_ref === 'abdxvlykasqmknexxhjo', 'SOURCE_PROJECT_MISMATCH');
require(evidence.target_project_ref &&
  evidence.target_project_ref !== evidence.source_project_ref, 'DISPOSABLE_TARGET_REQUIRED');
require(evidence.source_migrations?.count === expectedCount, 'SOURCE_MIGRATION_COUNT_STALE');
require(evidence.source_migrations?.latest_version ===
  expectedLatest, 'SOURCE_MIGRATION_VERSION_STALE');
require(/^[0-9a-f]{64}$/.test(
  String(evidence.source_migrations?.aggregate_sha256 ?? ''),
), 'SOURCE_MIGRATION_HASH_REQUIRED');
require(liveBaseline.migration_count === expectedCount, 'LIVE_BASELINE_COUNT_STALE');
require(liveBaseline.latest_version === expectedLatest, 'LIVE_BASELINE_VERSION_STALE');
require(/^[0-9a-f]{64}$/.test(
  String(liveBaseline.aggregate_sha256 ?? ''),
), 'LIVE_BASELINE_HASH_REQUIRED');
require(evidence.source_migrations?.aggregate_sha256 ===
  liveBaseline.aggregate_sha256, 'SOURCE_MIGRATION_HASH_STALE');
require(['ACTIVE_HEALTHY', 'REACHABLE_VERIFIED'].includes(
  evidence.source_state,
), 'SOURCE_PROJECT_NOT_HEALTHY');
require(evidence.target_state === 'ACTIVE_HEALTHY' ||
  (evidence.target_state === 'REACHABLE_VERIFIED' &&
    evidence.target_reachable_verified === true), 'DISPOSABLE_TARGET_NOT_ACTIVE_HEALTHY');
require(evidence.status === 'PASSED', 'REAL_REHEARSAL_NOT_PASSED');
require(evidence.backup?.status === 'SUCCEEDED', 'REAL_BACKUP_NOT_SUCCEEDED');
require(evidence.backup?.integrity_verified === true, 'REAL_BACKUP_INTEGRITY_REQUIRED');
require(evidence.backup?.encrypted === true, 'REAL_BACKUP_ENCRYPTION_REQUIRED');
require(evidence.backup?.manifest_hmac_verified === true, 'REAL_BACKUP_HMAC_REQUIRED');
require(evidence.backup?.primary_replica_verified === true, 'REAL_BACKUP_REPLICA_REQUIRED');
require(evidence.backup?.schema_version === expectedLatest, 'REAL_BACKUP_SCHEMA_STALE');
require(evidence.restore_test?.status === 'SUCCEEDED', 'REAL_RESTORE_TEST_NOT_SUCCEEDED');
require(evidence.restore_test?.migration_count ===
  expectedCount, 'RESTORE_MIGRATION_COUNT_MISMATCH');
require(evidence.restore_test?.migration_latest_version ===
  expectedLatest, 'RESTORE_MIGRATION_VERSION_MISMATCH');
require(evidence.restore_test?.migration_aggregate_sha256 ===
  evidence.source_migrations?.aggregate_sha256, 'RESTORE_MIGRATION_HASH_MISMATCH');
for (const key of [
  'database_verified',
  'auth_verified',
  'storage_verified',
  'private_state_verified',
  'rls_verified',
  'sessions_invalidated',
]) {
  require(evidence.restore_test?.[key] === true, `RESTORE_${key.toUpperCase()}_REQUIRED`);
}
require(Number.isFinite(evidence.documented_rpo_minutes) &&
  evidence.documented_rpo_minutes > 0, 'DOCUMENTED_RPO_REQUIRED');
require(Number.isFinite(evidence.documented_rto_minutes) &&
  evidence.documented_rto_minutes > 0, 'DOCUMENTED_RTO_REQUIRED');

if (errors.length) {
  console.error(
    JSON.stringify(
      {
        status: 'BLOCKED',
        gate: 'STEP12_REAL_REHEARSAL',
        expected: {
          migration_count: expectedCount,
          migration_latest_version: expectedLatest,
        },
        evidence_status: evidence.status,
        blocking_reason: evidence.blocking_reason ?? null,
        errors,
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
console.log('STEP12_REAL_REHEARSAL_GATE=PASSED');
