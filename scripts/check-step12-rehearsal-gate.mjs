import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Test the validator against the historical, genuine 130-migration snapshot.
// Never rewrite or forward-date a successful restore proof for a later schema.
const currentManifest = JSON.parse(await readFile('supabase/migration-manifest.json', 'utf8'));
const baseline = JSON.parse(
  await readFile('docs/evidence/step12-migration-sync-130-2026-10-06.json', 'utf8'),
);
const historicalRows = currentManifest.migrations.slice(0, baseline.migration_count);
if (
  historicalRows.length !== baseline.migration_count ||
  historicalRows.at(-1)?.version !== baseline.latest_version
)
  throw new Error('HISTORICAL_REHEARSAL_BASELINE_NOT_IN_CURRENT_SOURCE');
const expectedCount = baseline.migration_count;
const expectedLatest = baseline.latest_version;
const expectedHash = baseline.aggregate_sha256;
const verifier = resolve('scripts/check-step12-real-rehearsal.mjs');
const projectRoot = process.cwd();

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
async function run(name, evidence, shouldPass, expectedError = null, cwd = dir) {
  const file = join(dir, `${name}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  const result = spawnSync(process.execPath, [verifier, '--evidence', file], {
    cwd,
    encoding: 'utf8',
  });
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (shouldPass && result.status !== 0) throw new Error(`EXPECTED_PASS:${name}:${combined}`);
  if (!shouldPass && result.status === 0) throw new Error(`EXPECTED_FAIL:${name}`);
  if (expectedError && !combined.includes(expectedError))
    throw new Error(`EXPECTED_ERROR_MISSING:${name}:${expectedError}:${combined}`);
}
try {
  await mkdir(join(dir, 'supabase'), { recursive: true });
  await mkdir(join(dir, 'docs/evidence'), { recursive: true });
  await writeFile(
    join(dir, 'supabase/migration-manifest.json'),
    `${JSON.stringify({ migrations: historicalRows }, null, 2)}\n`,
  );
  await writeFile(
    join(dir, 'docs/evidence/step12-migration-sync-130-2026-10-06.json'),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );

  await run('valid-historical-proof', structuredClone(base), true);

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

  // The current local 131-migration source must NOT accept the historical proof.
  if (currentManifest.migrations.length > historicalRows.length) {
    await run(
      'current-source-rejects-historical-proof',
      structuredClone(base),
      false,
      'LIVE_BASELINE_COUNT_STALE',
      projectRoot,
    );
  }
  console.log(
    `STEP12_REAL_REHEARSAL_VALIDATOR_TEST=PASSED_${currentManifest.migrations.length > historicalRows.length ? 8 : 7}_OF_${currentManifest.migrations.length > historicalRows.length ? 8 : 7} (historical proof only; current restore gate remains closed)`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
