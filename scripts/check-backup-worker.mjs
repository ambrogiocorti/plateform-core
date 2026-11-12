import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptVerified } from '../tools/backup-worker/crypto.mjs';
import { checkPrerequisites } from '../tools/backup-worker/config.mjs';

const source = {
  start: await readFile(new URL('../tools/backup-worker/start.mjs', import.meta.url), 'utf8'),
  dump: await readFile(new URL('../tools/backup-worker/dump.mjs', import.meta.url), 'utf8'),
  protocol: await readFile(new URL('../tools/backup-worker/protocol.mjs', import.meta.url), 'utf8'),
  config: await readFile(new URL('../tools/backup-worker/config.mjs', import.meta.url), 'utf8'),
  replica: await readFile(new URL('../tools/backup-worker/replica.mjs', import.meta.url), 'utf8'),
  storageMeta: await readFile(
    new URL('../tools/backup-worker/storage-metadata.mjs', import.meta.url),
    'utf8',
  ),
};

const compact = (value) => value.replace(/\s+/g, '');
const contains = (value, marker) => compact(value).includes(compact(marker));
const position = (value, marker) => compact(value).indexOf(compact(marker));
const checks = [
  [
    'check-before-claim',
    position(source.start, 'checkPrerequisites(config)') <
      position(source.start, 'claimBackup(config)'),
  ],
  [
    'docker-before-claim',
    contains(source.dump, "'db', 'dump'") &&
      position(source.start, 'checkPrerequisites(config)') <
        position(source.start, 'claimBackup(config)'),
  ],
  ['service-role-rpc', contains(source.protocol, 'serviceRoleKey')],
  [
    'server-key-validator',
    contains(source.config, 'assertSupabaseServerKey') &&
      contains(source.config, "assertSupabaseServerKey('SUPABASE_SERVICE_ROLE_KEY'"),
  ],
  [
    'ambiguous-commit-reconciliation',
    contains(source.protocol, 'finishBackupSuccess') &&
      contains(source.protocol, 'BACKUP_COMMIT_AMBIGUOUS') &&
      contains(source.protocol, 'BACKUP_COMMIT_STATE_MISMATCH'),
  ],
  [
    'preserve-on-ambiguous-commit',
    contains(source.start, "message==='BACKUP_COMMIT_AMBIGUOUS'") &&
      contains(source.start, "message==='BACKUP_COMMIT_STATE_MISMATCH'"),
  ],
  [
    'portable-backup-reference',
    contains(source.start, "backupArtifactReference(id,'database')") &&
      contains(source.start, "backupArtifactReference(id,'auth')") &&
      contains(source.start, "backupArtifactReference(id,'storage')"),
  ],
  [
    'source-db-project-binding',
    contains(source.config, 'CONFIG_PROJECT_REF_MISMATCH:SUPABASE_DB_URL') &&
      contains(source.config, 'databaseProjectRef'),
  ],
  ['official-dump-role', contains(source.dump, "'--role-only'")],
  ['official-dump-data', contains(source.dump, "'--use-copy', '--data-only'")],
  [
    'auth-in-official-data-dump',
    contains(source.dump, 'authUsersInCopy(data)') &&
      contains(source.dump, "authSource: 'data.sql'"),
  ],
  ['auth-fail-closed', contains(source.dump, "throw new Error('AUTH_DUMP_MISSING')")],
  [
    'migration-history-schema-dump',
    contains(source.dump, "'--schema', 'supabase_migrations'") &&
      contains(source.dump, 'history_schema.sql') &&
      contains(source.dump, 'history_data.sql'),
  ],
  [
    'continuity-state-before-after',
    contains(source.dump, 'CONTINUITY_STATE_SQL') &&
      contains(source.dump, 'const before=await continuityState(config)') &&
      contains(source.dump, 'const after=await continuityState(config)') &&
      contains(source.dump, 'migrationLatestVersion') &&
      contains(source.dump, 'migrationAggregateSha256') &&
      contains(source.dump, "'private_state',${durablePrivateStateSql()}") &&
      contains(source.dump, 'DURABLE_PRIVATE_TABLES.length') &&
      contains(source.dump, 'privateState'),
  ],
  [
    'private-state-in-manifest',
    contains(source.start, 'private_state:{') &&
      contains(source.start, "policy:'durable-private-v1'") &&
      contains(source.start, "security_sanitization:'invalidate-runtime-security-state-v1'"),
  ],
  ['encryption-gate', contains(source.start, 'encryptVerified')],
  [
    'all-components-verified',
    [
      'database: true',
      'migrations: true',
      'auth: true',
      'private_state: true',
      'storage: true',
      'storage_metadata: true',
      'replica: true',
      'replica_file_count: replica.fileCount',
      'replica_size_bytes: replica.sizeBytes',
      'replica_hash: replica.aggregateSha256',
      'manifest: true',
      'manifest_auth: true',
    ].every((marker) => contains(source.start, marker)),
  ],
  [
    'manifest-hmac-before-replica',
    contains(source.start, "manifest_auth:{algorithm:'HMAC-SHA256',file:'manifest.hmac'}") &&
      contains(source.start, 'hmacSha256Text(manifestText,config.encryptionKey)') &&
      position(source.start, "writeFile(join(directory,'manifest.hmac')") <
        position(source.start, 'const replica=await replicateBackupDirectory'),
  ],
  [
    'replica-required-in-manifest',
    contains(source.start, 'durability:{replica_required:true}') &&
      contains(source.start, 'replicateBackupDirectory'),
  ],
  [
    'replica-verified-before-success',
    position(source.start, 'const replica=await replicateBackupDirectory') <
      position(source.start, 'finishBackupSuccess(config'),
  ],
  [
    'migration-history-in-manifest',
    contains(source.start, 'components:{') &&
      contains(source.start, 'migrations:{') &&
      contains(source.start, 'history_schema.sql.enc') &&
      contains(source.start, 'history_data.sql.enc') &&
      contains(source.start, 'latest_version:db.migrationLatestVersion'),
  ],
  [
    'storage-metadata-fingerprint',
    contains(source.start, 'storageMetadataState') &&
      contains(source.start, 'metadata_fingerprint') &&
      contains(source.start, 'storage_metadata:true'),
  ],
  [
    'unsupported-storage-mode-fail-closed',
    contains(source.start, 'assertStorageBackupSnapshot') &&
      contains(source.storageMeta, 'STORAGE_BUCKET_MODE_UNSUPPORTED'),
  ],
  [
    'database-snapshot-change-fail-closed',
    contains(source.dump, 'DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP'),
  ],
  ['auth-count-mismatch-fail-closed', contains(source.dump, 'AUTH_DUMP_COUNT_MISMATCH')],
  [
    'storage-snapshot-change-fail-closed',
    contains(source.start, 'assertStorageBackupSnapshot') &&
      contains(source.storageMeta, 'STORAGE_SNAPSHOT_CHANGED_DURING_BACKUP'),
  ],
  [
    'storage-count-mismatch-fail-closed',
    contains(source.start, 'assertStorageBackupSnapshot') &&
      contains(source.storageMeta, 'STORAGE_SNAPSHOT_COUNT_MISMATCH'),
  ],
  [
    'no-success-before-manifest',
    position(source.start, 'const manifest=') <
      position(source.start, 'finishBackupSuccess(config'),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`STATIC:${failed.join(',')}`);

const dir = await mkdtemp(join(tmpdir(), 'plateform-backup-worker-'));
const replicaDir = await mkdtemp(join(tmpdir(), 'plateform-backup-replica-'));
try {
  const sourcePath = join(dir, 'payload.bin');
  const bytes = Buffer.from('Plateform backup encryption verification\n'.repeat(16));
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  const encrypted = await encryptVerified(sourcePath, Buffer.from([...Array(32).keys()]));
  if (!encrypted.path.endsWith('.enc')) throw new Error('ENCRYPTED_PATH');
  if ((await stat(encrypted.path)).size <= 0) throw new Error('ENCRYPTED_EMPTY');
  await stat(sourcePath).then(
    () => {
      throw new Error('PLAINTEXT_RETAINED');
    },
    () => undefined,
  );

  let prerequisiteCode = '';
  try {
    await checkPrerequisites({
      leaseSeconds: 300,
      backupRoot: dir,
      replicaRoot: replicaDir,
      allowSameDeviceReplica: true,
      encryptionKeyId: 'test-key',
      supabaseCli: 'plateform-definitely-missing-supabase-cli',
      psql: 'plateform-definitely-missing-psql',
      docker: 'plateform-definitely-missing-docker',
      allowRootfulDocker: false,
    });
  } catch (error) {
    prerequisiteCode = error instanceof Error ? error.message : '';
  }
  if (!prerequisiteCode.startsWith('PREREQUISITE_MISSING:'))
    throw new Error(`PREFLIGHT_NOT_FAIL_CLOSED:${prerequisiteCode}`);
} finally {
  await rm(dir, { recursive: true, force: true });
  await rm(replicaDir, { recursive: true, force: true });
}
console.log('STEP12_BACKUP_WORKER_STATIC_GATE=PASSED');
console.log('STEP12_BACKUP_ENCRYPTION_ROUNDTRIP=PASSED');
console.log('STEP12_BACKUP_PREFLIGHT_FAIL_CLOSED=PASSED');
