import { readFile } from 'node:fs/promises';
const start = await readFile(
  new URL('../tools/restore-test-worker/start.mjs', import.meta.url),
  'utf8',
);
const config = await readFile(
  new URL('../tools/restore-test-worker/config.mjs', import.meta.url),
  'utf8',
);
const storage = await readFile(
  new URL('../tools/restore-test-worker/storage.mjs', import.meta.url),
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

const compact = (value) => value.replace(/\s+/g, '');
const contains = (value, marker) => compact(value).includes(compact(marker));
const position = (value, marker) => compact(value).indexOf(compact(marker));
const checks = [
  [
    'preflight-before-claim',
    position(start, 'checkPrerequisites(config)') < position(start, 'claimRestoreTest(config)'),
  ],
  ['isolated-target', contains(config, 'RESTORE_TARGET_MUST_BE_ISOLATED')],
  ['destructive-ack', contains(config, 'RESTORE_TEST_DESTRUCTIVE_ACK_REQUIRED')],
  [
    'strong-target-confirmation',
    contains(config, 'PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF') &&
      contains(config, 'RESTORE_TEST_TARGET_CONFIRMATION_MISMATCH'),
  ],
  [
    'target-db-project-binding',
    contains(config, 'RESTORE_TEST_DB_PROJECT_REF_MISMATCH') &&
      contains(config, 'databaseProjectRef'),
  ],
  [
    'server-key-validator',
    contains(config, 'assertSupabaseServerKey') &&
      contains(config, "assertSupabaseServerKey('SUPABASE_SERVICE_ROLE_KEY'") &&
      contains(config, "assertSupabaseServerKey('PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY'"),
  ],
  [
    'target-empty-gate',
    contains(start, 'RESTORE_TARGET_NOT_EMPTY') && contains(config, 'targetOccupied'),
  ],
  [
    'official-psql-sequence',
    contains(database, "'--single-transaction'") &&
      contains(database, "'SET session_replication_role = replica'"),
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
    'auth-from-data-dump',
    contains(start, 'verified_in_data_dump') && contains(database, "'--file', files.data"),
  ],
  ['manifest-checksum', contains(start, 'BACKUP_MANIFEST_CHECKSUM_MISMATCH')],
  [
    'manifest-hmac',
    contains(start, 'verifyHmacSha256Text') &&
      contains(start, 'BACKUP_MANIFEST_AUTH_REQUIRED') &&
      contains(start, "'manifest.hmac'"),
  ],
  [
    'target-storage-empty-gate',
    contains(start, 'RESTORE_TARGET_STORAGE_NOT_EMPTY') &&
      contains(start, 'targetStorageEmpty(config,createClient)'),
  ],
  [
    'storage-content-verification',
    contains(storage, "createHash('sha256')") &&
      contains(storage, 'upsert:true') &&
      contains(start, 'verifyStorage(config,manifest,createClient)'),
  ],
  [
    'storage-metadata-verification',
    contains(start, 'verifyStorageMetadata') &&
      contains(start, '...storageMetadata') &&
      contains(storageMetadata, 'storage_metadata_hash') &&
      contains(storageMetadata, 'storage_metadata:'),
  ],
  ['verify-resume-no-second-restore', contains(start, "job.status==='VERIFYING'")],
  [
    'fourteen-verification-gates',
    contains(
      start,
      "'database','migrations','auth','private_state','storage','storage_metadata','manifest','manifest_auth','rls','accounts','payments','audit','sessions','devices'",
    ),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(`STEP12_RESTORE_TEST_STATIC_GATE=FAILED:${failed.join(',')}`);
  process.exit(1);
}
console.log('STEP12_RESTORE_TEST_STATIC_GATE=PASSED');
