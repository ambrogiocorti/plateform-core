import { readFile } from 'node:fs/promises';

const auditMigration = await readFile(
  new URL('../supabase/migrations/20261006044128_step12_audit_error_code_visibility.sql', import.meta.url),
  'utf8',
);
const backupState = await readFile(
  new URL('../supabase/migrations/20261004155630_step12_schema_snapshot_binding.sql', import.meta.url),
  'utf8',
);
const restoreCutover = await readFile(
  new URL('../supabase/migrations/20261004125043_step12_restore_cutover_gate.sql', import.meta.url),
  'utf8',
);

const checks = [
  [auditMigration.includes("'error_code','purpose'"), 'audit technical fields whitelist'],
  [auditMigration.includes('create or replace function private.audit_values'), 'audit_values override'],
  [backupState.includes("'BACKUP_FAILED'"), 'backup failure audit action'],
  [backupState.includes("'error_code',trim(p_error_code)"), 'backup failure error code payload'],
  [backupState.includes("'purpose',job.purpose"), 'backup failure purpose payload'],
  [restoreCutover.includes("'error_code',trim(p_error_code)"), 'restore failure error code payload'],
  [restoreCutover.includes("'CUTOVER_ABORTED'"), 'cutover abort code'],
];

const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`STEP12_AUDIT_OBSERVABILITY_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log(`STEP12_AUDIT_OBSERVABILITY_GATE=PASSED_${checks.length}_OF_${checks.length}`);
