import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  'check-migrations.mjs',
  'check-backup-worker.mjs',
  'check-restore-test-worker.mjs',
  'check-restore-worker.mjs',
  'check-private-recovery-policy.mjs',
  'check-backup-snapshot-consistency.mjs',
  'check-backup-replica.mjs',
  'check-backup-manifest-auth.mjs',
  'check-operational-release-metadata.mjs',
  'check-continuity-contract.mjs',
  'check-continuity-project-binding.mjs',
  'check-backup-retention-worker.mjs',
  'check-restore-cutover.mjs',
  'check-continuity-alerting.mjs',
  'check-continuity-targets.mjs',
  'check-migration-history-recovery.mjs',
  'check-storage-metadata-integrity.mjs',
  'check-retention-ui.mjs',
  'check-backup-keyring.mjs',
  'check-backup-filesystem-safety.mjs',
  'check-backup-commit-reconciliation.mjs',
  'check-continuity-server-key.mjs',
  'check-continuity-installer.mjs',
  'check-continuity-bootstrap.mjs',
  'check-continuity-activation.mjs',
  'check-continuity-secret-config.mjs',
  'check-runbook-post-restore-reconciliation.mjs',
  'check-continuity-worker-health.mjs',
  'check-step12-audit-observability.mjs',
  'check-api-permission-manifest-alignment.mjs',
  'check-step12-restore-reference-indexes.mjs',
  'check-step12-continuity-table-access.mjs',
  'check-step12-backup-requester-index.mjs',
  'check-step12-rehearsal-gate.mjs',
];
const failures = [];
for (const check of checks) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', check)], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) failures.push({ check, status: result.status, signal: result.signal });
}
if (failures.length) {
  console.error(JSON.stringify({ status: 'FAILED', total: checks.length, failures }, null, 2));
  process.exit(1);
}
console.log(`STEP12_STATIC_REGRESSION=${checks.length}_OF_${checks.length}_PASSED`);
