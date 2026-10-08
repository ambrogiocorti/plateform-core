import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../supabase/migrations/20261004121556_step12_continuity_alerting.sql', import.meta.url),
  'utf8',
);
const technical = await readFile(new URL('../src/pages/technical.ts', import.meta.url), 'utf8');
const staffCss = await readFile(new URL('../styles/staff.css', import.meta.url), 'utf8');

const checks = [
  [migration.includes('automation_key'), 'automation key'],
  [migration.includes('one_open_automated_incident'), 'deduplication index'],
  [migration.includes('reconcile_continuity_alerts'), 'continuity reconciler'],
  [migration.includes("'*/10 * * * *'"), '10 minute cron'],
  [migration.includes('CONTINUITY_BACKUP_FAILED'), 'backup failure alert'],
  [migration.includes('CONTINUITY_RESTORE_FAILED'), 'restore failure alert'],
  [migration.includes('AUTO_RESOLVED'), 'automatic recovery event'],
  [migration.includes('from public,anon,authenticated'), 'public execution revoked'],
  [technical.includes('continuityIncidents'), 'technical alert selection'],
  [technical.includes("role: 'alert'"), 'accessible incident banner'],
  [technical.includes("status('AUTO')"), 'automatic incident label'],
  [staffCss.includes('.incident-banner'), 'incident banner styling'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_CONTINUITY_ALERTING_STATIC_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log('STEP12_CONTINUITY_ALERTING_STATIC_GATE=PASSED');
