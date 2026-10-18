import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, checkPrerequisites } from './config.mjs';
import { claimBackup, finishBackup, finishBackupSuccess } from './protocol.mjs';
import { dumpDatabase } from './dump.mjs';
import { exportStorage } from './storage.mjs';
import { assertStorageBackupSnapshot, storageMetadataState } from './storage-metadata.mjs';
import { encryptVerified, hmacSha256Text, sha256Text } from './crypto.mjs';
import { backupArtifactReference, prepareBackupDirectory } from './filesystem.mjs';
import { removeReplicaDirectory, replicateBackupDirectory } from './replica.mjs';
import { captureManagedOverlay, securitySurfaceState } from './managed-surface.mjs';

function safeError(error) {
  const raw = error instanceof Error ? error.message : 'BACKUP_WORKER_FAILED';
  const code = raw.split(':')[0].replace(/[^A-Z0-9_]/g, '_');
  return code.length >= 2 && code.length <= 80 ? code : 'BACKUP_WORKER_FAILED';
}

async function processJob(config, job) {
  const id = String(job.id),
    leaseToken = String(job.lease_token);
  const directory = await prepareBackupDirectory(config.backupRoot, id);
  try {
    const surfaceBefore = await securitySurfaceState(config.psql, config.databaseUrl);
    const db = await dumpDatabase(config, directory);
    const overlay = await captureManagedOverlay(
      config.psql,
      config.databaseUrl,
      join(directory, 'managed_overlay.sql'),
      join(directory, 'schedules.sql'),
    );
    const surface = await securitySurfaceState(config.psql, config.databaseUrl);
    if (surface.hashes.aggregate_sha256 !== surfaceBefore.hashes.aggregate_sha256)
      throw new Error('DATABASE_SNAPSHOT_CHANGED_DURING_BACKUP');
    const { createClient } = await import('@supabase/supabase-js');
    const storageBefore = await storageMetadataState(config.psql, config.databaseUrl);
    const storage = await exportStorage(config, directory, createClient);
    const storageAfter = await storageMetadataState(config.psql, config.databaseUrl);
    const storageMetadata = assertStorageBackupSnapshot(storageBefore, storageAfter, storage);
    const plaintext = [
      db.roles,
      db.schema,
      db.data,
      db.historySchema,
      db.historyData,
      join(directory, 'managed_overlay.sql'),
      join(directory, 'schedules.sql'),
      ...storage.objects.map((row) => row.path),
    ];
    const encrypted = [];
    for (const path of plaintext) {
      const result = await encryptVerified(path, config.encryptionKey);
      encrypted.push({
        file: relative(directory, result.path),
        size_bytes: result.sizeBytes,
        sha256: result.sha256,
        plaintext_sha256: result.plaintextSha256,
        iv: result.iv,
        tag: result.tag,
        algorithm: result.algorithm,
      });
    }
    const storageIndex = new Map(
      storage.objects.map((row) => [`${relative(directory, row.path)}.enc`, row]),
    );
    const manifest = {
      format_version: 2,
      backup_id: id,
      purpose: String(job.purpose),
      created_at: new Date().toISOString(),
      encryption_key_id: config.encryptionKeyId,
      source_project_ref: config.sourceProjectRef,
      manifest_auth: { algorithm: 'HMAC-SHA256', file: 'manifest.hmac' },
      durability: { replica_required: true },
      components: {
        database: encrypted.filter((row) =>
          ['roles.sql.enc', 'schema.sql.enc', 'data.sql.enc'].includes(row.file),
        ),
        migrations: {
          files: encrypted.filter((row) =>
            ['history_schema.sql.enc', 'history_data.sql.enc'].includes(row.file),
          ),
          count: db.migrationCount,
          latest_version: db.migrationLatestVersion,
          aggregate_sha256: db.migrationAggregateSha256,
        },
        managed_overlay: {
          policy: 'managed-overlay-v1',
          files: encrypted.filter((row) =>
            ['managed_overlay.sql.enc', 'schedules.sql.enc'].includes(row.file),
          ),
          ...overlay,
        },
        security_surface: { policy: 'security-surface-v1', ...surface.hashes },
        auth: {
          source_artifact: 'data.sql.enc',
          user_count: db.authUserCount,
          verified_in_data_dump: true,
        },
        private_state: {
          policy: 'durable-private-v1',
          durable_table_count: Number(db.privateState.table_count),
          durable_row_count: Number(db.privateState.row_count),
          durable_aggregate_sha256: String(db.privateState.aggregate_sha256),
          security_sanitization: 'invalidate-runtime-security-state-v1',
        },
        storage: {
          buckets: storage.buckets,
          metadata_fingerprint: {
            bucket_count: storageMetadata.bucketCount,
            object_count: storageMetadata.objectCount,
            aggregate_sha256: storageMetadata.aggregateSha256,
          },
          objects: encrypted
            .filter((row) => storageIndex.has(row.file))
            .map((row) => ({
              ...row,
              bucket: storageIndex.get(row.file).bucket,
              name: storageIndex.get(row.file).name,
              metadata: storageIndex.get(row.file).metadata,
            })),
        },
      },
    };
    const manifestText = JSON.stringify(manifest);
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, manifestText, { mode: 0o600 });
    await writeFile(
      join(directory, 'manifest.hmac'),
      hmacSha256Text(manifestText, config.encryptionKey),
      { mode: 0o600 },
    );
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      parsed.format_version !== 2 ||
      parsed.manifest_auth?.algorithm !== 'HMAC-SHA256' ||
      parsed.manifest_auth?.file !== 'manifest.hmac' ||
      parsed.durability?.replica_required !== true ||
      !parsed.components?.database ||
      !parsed.components?.migrations ||
      !parsed.components?.auth ||
      !parsed.components?.storage ||
      parsed.components?.managed_overlay?.files?.length !== 2 ||
      !/^[0-9a-f]{64}$/.test(String(parsed.components?.security_surface?.aggregate_sha256 ?? ''))
    )
      throw new Error('BACKUP_MANIFEST_VERIFY_FAILED');
    const replica = await replicateBackupDirectory(directory, config.replicaRoot, id);
    const sizeBytes = encrypted.reduce((sum, row) => sum + row.size_bytes, 0);
    const checksum = sha256Text(manifestText);
    const commit = await finishBackupSuccess(config, {
      id,
      leaseToken,
      databaseReference: backupArtifactReference(id, 'database'),
      authReference: backupArtifactReference(id, 'auth'),
      storageReference: backupArtifactReference(id, 'storage'),
      manifest,
      verification: {
        database: true,
        migrations: true,
        auth: true,
        private_state: true,
        storage: true,
        storage_metadata: true,
        replica: true,
        replica_file_count: replica.fileCount,
        replica_size_bytes: replica.sizeBytes,
        replica_hash: replica.aggregateSha256,
        manifest: true,
        manifest_auth: true,
        managed_overlay: true,
        security_surface: true,
      },
      checksum,
      sizeBytes,
      objectCount: storage.objects.length,
      encryptionKeyId: config.encryptionKeyId,
    });
    return {
      id,
      status: 'SUCCEEDED',
      sizeBytes,
      objectCount: storage.objects.length,
      replicaFiles: replica.fileCount,
      replicaHash: replica.aggregateSha256,
      reconciledCommit: commit.reconciled,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'BACKUP_COMMIT_AMBIGUOUS' || message === 'BACKUP_COMMIT_STATE_MISMATCH')
      throw error;
    const errorCode = safeError(error);
    let recorded = false;
    try {
      await finishBackup(config, {
        id,
        leaseToken,
        success: false,
        manifest: {},
        verification: {},
        errorCode,
      });
      recorded = true;
    } catch (finishError) {
      throw new AggregateError([error, finishError], `BACKUP_FAILURE_NOT_RECORDED:${errorCode}`, {
        cause: finishError,
      });
    } finally {
      if (recorded) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        if (errorCode !== 'BACKUP_REPLICA_IMMUTABLE_CONFLICT')
          await removeReplicaDirectory(config.replicaRoot, id).catch(() => undefined);
      }
    }
    throw error;
  }
}

// Exported so the local disaster-recovery rehearsal can drive the exact same job
// pipeline against a disposable PostgreSQL; the CLI below is unchanged.
export { processJob };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2] ?? '--check';
  const config = loadConfig();
  const prerequisite = await checkPrerequisites(config);
  if (mode === '--check') {
    console.log(JSON.stringify({ status: 'READY', ...prerequisite }));
    process.exit(0);
  }
  if (mode !== '--once') throw new Error('USAGE: backup-worker --check|--once');
  const job = await claimBackup(config);
  if (!job) {
    console.log(JSON.stringify({ status: 'IDLE' }));
    process.exit(0);
  }
  console.log(JSON.stringify(await processJob(config, job)));
}
