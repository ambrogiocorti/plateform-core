import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
const expectedCount = manifest.migrations.length;
const expectedLatest = manifest.migrations.at(-1).version;
const baseline = JSON.parse(
  await readFile('docs/evidence/step12-migration-sync-130-2026-10-06.json', 'utf8'),
);
const expectedHash = baseline.aggregate_sha256;

const base = {
  date: '2026-10-06T07:30:00+02:00',
  status: 'PASSED',
  source_project_ref: 'abdxvlykasqmknexxhjo',
  source_state: 'REACHABLE_VERIFIED',
  target_project_ref: 'dkbjgvovxgglqhqxmuyb',
  target_project_name: 'plateform-restore-test',
  target_state: 'REACHABLE_VERIFIED',
  target_reachable_verified: true,
  source_migrations: {
    count: expectedCount,
    latest_version: expectedLatest,
    aggregate_sha256: expectedHash,
  },
  backup: {
    status: 'SUCCEEDED',
    integrity_verified: true,
    encrypted: true,
    manifest_hmac_verified: true,
    primary_replica_verified: true,
    schema_version: expectedLatest,
  },
  restore_test: {
    status: 'SUCCEEDED',
    migration_count: expectedCount,
    migration_latest_version: expectedLatest,
    migration_aggregate_sha256: expectedHash,
    database_verified: true,
    auth_verified: true,
    storage_verified: true,
    private_state_verified: true,
    rls_verified: true,
    sessions_invalidated: true,
  },
  documented_rpo_minutes: 60,
  documented_rto_minutes: 60,
};

const dir = await mkdtemp(join(tmpdir(), 'plateform-step12-rehearsal-gate-'));
async function run(name, evidence, shouldPass, expectedError = null) {
  const file = join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['scripts/check-step12-real-rehearsal.mjs', '--evidence', file], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (shouldPass && result.status !== 0) throw new Error(`EXPECTED_PASS:${name}:${combined}`);
  if (!shouldPass && result.status === 0) throw new Error(`EXPECTED_FAIL:${name}`);
  if (expectedError && !combined.includes(expectedError))
    throw new Error(`EXPECTED_ERROR_MISSING:${name}:${expectedError}`);
}
try {
  await run('valid', structuredClone(base), true);

  const sameTarget = structuredClone(base);
  sameTarget.target_project_ref = sameTarget.source_project_ref;
  await run('same-target', sameTarget, false, 'DISPOSABLE_TARGET_REQUIRED');

  const stale = structuredClone(base);
  stale.source_migrations.count -= 1;
  await run('stale-source', stale, false, 'SOURCE_MIGRATION_COUNT_STALE');

  const staleHash = structuredClone(base);
  staleHash.source_migrations.aggregate_sha256 = '0'.repeat(64);
  staleHash.restore_test.migration_aggregate_sha256 = '0'.repeat(64);
  await run('stale-hash', staleHash, false, 'SOURCE_MIGRATION_HASH_STALE');

  const backup = structuredClone(base);
  backup.backup.integrity_verified = false;
  await run('backup-not-verified', backup, false, 'REAL_BACKUP_INTEGRITY_REQUIRED');

  const restore = structuredClone(base);
  restore.restore_test.storage_verified = false;
  await run('restore-incomplete', restore, false, 'RESTORE_STORAGE_VERIFIED_REQUIRED');

  const target = structuredClone(base);
  target.target_state = 'INACTIVE';
  target.target_reachable_verified = false;
  await run('target-inactive', target, false, 'DISPOSABLE_TARGET_NOT_ACTIVE_HEALTHY');

  console.log('STEP12_REAL_REHEARSAL_GATE_TEST=PASSED_7_OF_7');
} finally {
  await rm(dir, { recursive: true, force: true });
}
