import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, checkPrerequisites } from './config.mjs';
import { claimRestoreTest, backupMetadata, markVerifying, finishRestore } from './protocol.mjs';
import { decryptVerified, sha256Text, verifyHmacSha256Text } from '../backup-worker/crypto.mjs';
import { resolveEncryptionKey } from '../backup-worker/keyring.mjs';
import { resolveBackupArtifact, resolveBackupDirectory } from '../backup-worker/filesystem.mjs';
import { verifyStorageMetadata } from '../backup-worker/storage-metadata.mjs';
import {
  restoreDatabase,
  verifyDatabase,
  verifyMigrationHistory,
  quiesceTargetAutomation,
  sanitizeRestoredSecurityState,
  verifyPrivateState,
} from './database.mjs';
import { restoreStorage, verifyStorage, targetStorageEmpty } from './storage.mjs';

function safeCode(error) {
  const raw = error instanceof Error ? error.message : 'RESTORE_TEST_FAILED';
  const code = raw.split(':')[0].replace(/[^A-Z0-9_]/g, '_');
  return code.length >= 2 && code.length <= 80 ? code : 'RESTORE_TEST_FAILED';
}
function findArtifact(manifest, name) {
  const row = manifest.components?.database?.find((item) => item.file === `${name}.enc`);
  if (!row) throw new Error(`BACKUP_ARTIFACT_MISSING:${name}`);
  return row;
}
function validateAuthManifest(manifest) {
  const auth = manifest.components?.auth;
  if (!auth || auth.source_artifact !== 'data.sql.enc' || auth.verified_in_data_dump !== true)
    throw new Error('BACKUP_AUTH_MANIFEST_INVALID');
  if (!Number.isInteger(auth.user_count) || auth.user_count < 0)
    throw new Error('BACKUP_AUTH_MANIFEST_INVALID');
}
async function processJob(config, job, temp, prerequisite) {
  const id = String(job.id),
    lease = String(job.lease_token),
    backupId = String(job.backup_id);
  let verifying = false;
  try {
    const backup = await backupMetadata(config, backupId);
    if (backup.status !== 'SUCCEEDED' || backup.integrity_verified !== true)
      throw new Error('RESTORE_BACKUP_NOT_ELIGIBLE');
    const backupDir = await resolveBackupDirectory(
      backup.database_reference,
      config.backupRoot,
      backupId,
    );
    const manifestPath = join(backupDir, 'manifest.json');
    const manifestText = await readFile(manifestPath, 'utf8');
    if (sha256Text(manifestText) !== backup.checksum)
      throw new Error('BACKUP_MANIFEST_CHECKSUM_MISMATCH');
    const manifest = JSON.parse(manifestText);
    if (manifest.encryption_key_id !== backup.encryption_key_id)
      throw new Error('BACKUP_ENCRYPTION_KEY_MISMATCH');
    const encryptionKey = resolveEncryptionKey(config.encryptionKeys, backup.encryption_key_id);
    if (
      manifest.format_version !== 2 ||
      manifest.manifest_auth?.algorithm !== 'HMAC-SHA256' ||
      manifest.manifest_auth?.file !== 'manifest.hmac'
    )
      throw new Error('BACKUP_MANIFEST_AUTH_REQUIRED');
    verifyHmacSha256Text(
      manifestText,
      encryptionKey,
      await readFile(await resolveBackupArtifact(backupDir, 'manifest.hmac'), 'utf8'),
    );
    const { createClient } = await import('@supabase/supabase-js');
    if (job.status === 'RESTORING') {
      if (prerequisite.targetOccupied)
        throw new Error(
          Number(job.attempt) > 1 ? 'RESTORE_RECOVERY_REQUIRED' : 'RESTORE_TARGET_NOT_EMPTY',
        );
      if (!(await targetStorageEmpty(config, createClient)))
        throw new Error('RESTORE_TARGET_STORAGE_NOT_EMPTY');
      const dbDir = join(temp, 'database');
      await mkdir(dbDir, { recursive: true, mode: 0o700 });
      const files = {};
      for (const name of ['roles.sql', 'schema.sql', 'data.sql']) {
        const meta = findArtifact(manifest, name);
        const target = join(dbDir, name);
        await decryptVerified(
          await resolveBackupArtifact(backupDir, meta.file),
          target,
          encryptionKey,
          meta,
        );
        files[name.split('.')[0]] = target;
      }
      const migrations = manifest.components?.migrations;
      if (
        !migrations ||
        !Array.isArray(migrations.files) ||
        migrations.files.length !== 2 ||
        !Number.isInteger(migrations.count) ||
        migrations.count < 0 ||
        !/^[0-9]{14}$/.test(String(migrations.latest_version ?? '')) ||
        !/^[0-9a-f]{64}$/.test(String(migrations.aggregate_sha256 ?? ''))
      )
        throw new Error('BACKUP_MIGRATION_MANIFEST_INVALID');
      for (const name of ['history_schema.sql', 'history_data.sql']) {
        const meta = migrations.files.find((item) => item.file === `${name}.enc`);
        if (!meta) throw new Error(`BACKUP_ARTIFACT_MISSING:${name}`);
        const target = join(dbDir, name);
        await decryptVerified(
          await resolveBackupArtifact(backupDir, meta.file),
          target,
          encryptionKey,
          meta,
        );
        files[name === 'history_schema.sql' ? 'historySchema' : 'historyData'] = target;
      }
      validateAuthManifest(manifest);
      await restoreDatabase(config, files);
      await quiesceTargetAutomation(config);
      await sanitizeRestoredSecurityState(config);
      await restoreStorage(config, manifest, backupDir, temp, createClient, encryptionKey);
      await markVerifying(
        config,
        id,
        lease,
        `supabase://${config.targetProjectRef}/restore-test/${id}`,
      );
      verifying = true;
    } else if (job.status === 'VERIFYING') {
      verifying = true;
    } else {
      throw new Error('RESTORE_STATE_INVALID');
    }
    const db = await verifyDatabase(config);
    const migrationHistory = await verifyMigrationHistory(config, {
      count: manifest.components.migrations.count,
      latest_version: manifest.components.migrations.latest_version,
      aggregate_sha256: manifest.components.migrations.aggregate_sha256,
    });
    const privateState = await verifyPrivateState(config, manifest.components.private_state);
    const storageOk = await verifyStorage(config, manifest, createClient);
    const storageMetadata = await verifyStorageMetadata(
      config.psql,
      config.targetDatabaseUrl,
      manifest.components.storage.metadata_fingerprint,
    );
    const verification = {
      ...db,
      ...migrationHistory,
      ...privateState,
      ...storageMetadata,
      auth: db.auth === true && Number(db.auth_user_count) === manifest.components.auth.user_count,
      storage: storageOk,
      manifest: true,
      manifest_auth: true,
    };
    const required = [
      'database',
      'migrations',
      'auth',
      'private_state',
      'storage',
      'storage_metadata',
      'manifest',
      'manifest_auth',
      'rls',
      'accounts',
      'payments',
      'audit',
      'sessions',
      'devices',
    ];
    if (!required.every((key) => verification[key] === true))
      throw new Error('RESTORE_VERIFICATION_FAILED');
    await finishRestore(config, id, lease, true, verification, null);
    return { id, status: 'SUCCEEDED', target: config.targetProjectRef, verification };
  } catch (error) {
    const errorCode = safeCode(error);
    if (!verifying) {
      try {
        await markVerifying(
          config,
          id,
          lease,
          `supabase://${config.targetProjectRef}/restore-test/${id}/failed`,
        );
        verifying = true;
      } catch {
        /* best-effort transition before failure finalization */
      }
    }
    if (verifying)
      await finishRestore(config, id, lease, false, {}, errorCode).catch(() => undefined);
    throw error;
  }
}
const mode = process.argv[2] ?? '--check';
const config = loadConfig();
const prerequisite = await checkPrerequisites(config);
if (mode === '--check') {
  await rm(prerequisite.temp, { recursive: true, force: true });
  const blocked = prerequisite.targetOccupied === true;
  console.log(
    JSON.stringify({
      status: blocked ? 'BLOCKED' : 'READY',
      reason: blocked ? 'RESTORE_TARGET_NOT_EMPTY' : null,
      targetProjectRef: config.targetProjectRef,
      targetOccupied: blocked,
      psql: config.psql,
    }),
  );
  process.exit(blocked ? 2 : 0);
}
if (mode !== '--once') throw new Error('USAGE: restore-test-worker --check|--once');
// Do not claim or change a queued restore job when the destination is occupied.
if (prerequisite.targetOccupied === true) {
  await rm(prerequisite.temp, { recursive: true, force: true });
  console.error(
    JSON.stringify({
      status: 'BLOCKED',
      reason: 'RESTORE_TARGET_NOT_EMPTY',
      targetProjectRef: config.targetProjectRef,
    }),
  );
  process.exit(2);
}
const job = await claimRestoreTest(config);
if (!job) {
  await rm(prerequisite.temp, { recursive: true, force: true });
  console.log(JSON.stringify({ status: 'IDLE' }));
  process.exit(0);
}
try {
  console.log(JSON.stringify(await processJob(config, job, prerequisite.temp, prerequisite)));
} finally {
  await rm(prerequisite.temp, { recursive: true, force: true });
}
