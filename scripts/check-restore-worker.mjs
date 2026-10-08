import { readFile } from 'node:fs/promises';
const start = await readFile(new URL('../tools/restore-worker/start.mjs', import.meta.url), 'utf8');
const config = await readFile(
  new URL('../tools/restore-worker/config.mjs', import.meta.url),
  'utf8',
);
const protocol = await readFile(
  new URL('../tools/restore-worker/protocol.mjs', import.meta.url),
  'utf8',
);
const database = await readFile(
  new URL('../tools/restore-test-worker/database.mjs', import.meta.url),
  'utf8',
);
const storageMetadata = await readFile(
  new URL('../tools/backup-worker/storage-metadata.mjs', import.meta.url),
  'utf8',
);
const storage = await readFile(
  new URL('../tools/restore-test-worker/storage.mjs', import.meta.url),
  'utf8',
);

const compact = (value) => value.replace(/\s+/g, '');
const contains = (value, marker) => compact(value).includes(compact(marker));
const position = (value, marker) => compact(value).indexOf(compact(marker));
const checks = [
  [
    'preflight-before-claim',
    position(start, 'checkPrerequisites(config)') < position(start, 'claimRestore(config)'),
  ],
  ['replacement-project-only', contains(config, 'RESTORE_TARGET_MUST_BE_REPLACEMENT_PROJECT')],
  [
    'strong-target-confirmation',
    contains(config, 'PLATEFORM_RESTORE_TARGET_CONFIRM_PROJECT_REF') &&
      contains(config, 'RESTORE_TARGET_CONFIRMATION_MISMATCH'),
  ],
  [
    'target-db-project-binding',
    contains(config, 'RESTORE_DB_PROJECT_REF_MISMATCH') && contains(config, 'databaseProjectRef'),
  ],
  [
    'server-key-validator',
    contains(config, 'assertSupabaseServerKey') &&
      contains(config, "assertSupabaseServerKey('SUPABASE_SERVICE_ROLE_KEY'") &&
      contains(config, "assertSupabaseServerKey('PLATEFORM_RESTORE_TARGET_SERVICE_ROLE_KEY'"),
  ],
  ['destructive-ack', contains(config, 'RESTORE_DESTRUCTIVE_ACK_REQUIRED')],
  [
    'mode-isolation',
    contains(start, "job.mode!=='RESTORE'") && contains(protocol, "'claim_restore_job'"),
  ],
  [
    'pre-restore-required',
    contains(start, 'PRE_RESTORE_BACKUP_NOT_READY') && contains(start, 'pre_restore_backup_id'),
  ],
  ['target-db-empty', contains(start, 'RESTORE_TARGET_NOT_EMPTY')],
  [
    'target-storage-empty',
    contains(start, 'RESTORE_TARGET_STORAGE_NOT_EMPTY') &&
      contains(start, 'targetStorageEmpty(config,createClient)'),
  ],
  [
    'auth-from-data-dump',
    contains(start, 'verified_in_data_dump') && contains(database, "'--file', files.data"),
  ],
  [
    'manifest-hmac',
    contains(start, 'verifyHmacSha256Text') &&
      contains(start, 'BACKUP_MANIFEST_AUTH_REQUIRED') &&
      contains(start, "'manifest.hmac'"),
  ],
  [
    'migration-history-restore',
    contains(start, 'history_schema.sql') &&
      contains(start, 'history_data.sql') &&
      contains(database, 'files.historySchema') &&
      contains(database, 'files.historyData'),
  ],
  [
    'migration-history-verify',
    contains(start, 'verifyMigrationHistory') &&
      contains(database, 'migration_hash') &&
      contains(database, 'aggregate_sha256'),
  ],
  [
    'restore-maintenance-mode',
    contains(start, 'quiesceTargetAutomation') &&
      contains(start, 'sanitizeRestoredSecurityState') &&
      contains(database, "jobname like 'plateform-%'"),
  ],
  [
    'private-state-verification',
    contains(start, 'verifyPrivateState') &&
      contains(database, 'RESTORE_PRIVATE_STATE_MANIFEST_INVALID') &&
      contains(database, 'private_state:stateOk'),
  ],
  [
    'verify-resume',
    contains(start, "job.status==='VERIFYING'") &&
      contains(start, 'verifyTarget(config,manifest,createClient)'),
  ],
  ['storage-hash-verification', contains(storage, "createHash('sha256')")],
  [
    'storage-metadata-verification',
    contains(start, 'verifyStorageMetadata') &&
      contains(start, '...storageMetadata') &&
      contains(storageMetadata, 'storage_metadata_hash') &&
      contains(storageMetadata, 'storage_metadata:'),
  ],
  [
    'fourteen-verification-gates',
    contains(
      start,
      "'database','migrations','auth','private_state','storage','storage_metadata','manifest','manifest_auth','rls','accounts','payments','audit','sessions','devices'",
    ),
  ],
  [
    'cutover-explicit',
    contains(start, "status:'CUTOVER_REQUIRED'") && contains(start, 'requiresCutover:true'),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(`STEP12_RESTORE_WORKER_STATIC_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log('STEP12_RESTORE_WORKER_STATIC_GATE=PASSED');
