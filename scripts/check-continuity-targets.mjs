import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../supabase/migrations/20261004122645_step12_continuity_targets.sql', import.meta.url),
  'utf8',
);
const technical = await readFile(new URL('../src/pages/technical.ts', import.meta.url), 'utf8');

const checks = [
  [migration.includes('private.continuity_settings'), 'typed continuity settings'],
  [migration.includes('rpo_target_minutes'), 'RPO target'],
  [migration.includes('rto_target_minutes'), 'RTO target'],
  [migration.includes('restore_test_interval_days'), 'restore test interval'],
  [migration.includes('enqueue_due_backup'), 'due scheduler function'],
  [migration.includes("'*/5 * * * *'"), '5 minute scheduler check'],
  [migration.includes('RPO_TARGET_DUE'), 'RPO due reason'],
  [migration.includes('CONTINUITY_RTO_TARGET_MISSED'), 'RTO miss alert'],
  [technical.includes('continuity_targets'), 'UI continuity targets'],
  [technical.includes('Configura obiettivi RPO/RTO'), 'UI continuity editor'],
  [technical.includes('obiettivo, non SLA'), 'non-guarantee wording'],
  [technical.includes('last_restore_test_duration_seconds'), 'observed RTO metric'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_CONTINUITY_TARGETS_STATIC_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log('STEP12_CONTINUITY_TARGETS_STATIC_GATE=PASSED');
