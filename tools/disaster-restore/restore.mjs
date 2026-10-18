// Offline disaster restore (Step 12). Rebuilds an EMPTY replacement installation
// from one encrypted backup copy — the primary or the replica — when the source
// installation and its control plane are gone. Authenticity comes from the HMAC
// manifest (secret key), integrity from per-artifact SHA-256, and the restored
// installation must pass the same gates as the restore-test worker plus the
// managed overlay and security surface. The result is recorded in the restored
// installation as a RESTORE job in CUTOVER_REQUIRED: going live still needs a
// Super Admin cutover confirmation with step-up. pg_cron schedules stay off
// until activateSchedules() is called explicitly at cutover.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { decryptVerified, sha256Text, verifyHmacSha256Text } from '../backup-worker/crypto.mjs';
import { resolveEncryptionKey } from '../backup-worker/keyring.mjs';
import { resolveBackupArtifact, resolveBackupDirectory } from '../backup-worker/filesystem.mjs';
import { directoryProof } from '../backup-worker/replica.mjs';
import { verifyStorageMetadata } from '../backup-worker/storage-metadata.mjs';
import { applyManagedOverlay, managedOverlayCounts } from '../backup-worker/managed-surface.mjs';
import { TARGET_OCCUPANCY_SQL, parseTargetOccupancy } from '../continuity/target-occupancy.mjs';
import {
  restoreDatabase,
  verifyDatabase,
  verifyMigrationHistory,
  quiesceTargetAutomation,
  sanitizeRestoredSecurityState,
  verifyPrivateState,
  restoreManagedOverlay,
  verifyManagedSurface,
} from '../restore-test-worker/database.mjs';
import {
  restoreStorage,
  targetStorageEmpty,
  verifyStorage,
} from '../restore-test-worker/storage.mjs';

export const DISASTER_RESTORE_GATES = [
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
  'managed_overlay',
  'security_surface',
];

function psql(config, sql, code) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      config.psql,
      ['-X', '-A', '-t', '-q', '--set', 'ON_ERROR_STOP=1', '--dbname', config.targetDatabaseUrl],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    child.once('exit', (exit) =>
      exit === 0
        ? resolveResult(stdout.trim())
        : reject(
            new Error(
              `${code}:${exit}:${stderr.replaceAll(config.targetDatabaseUrl, '[REDACTED]').slice(0, 400)}`,
            ),
          ),
    );
    child.stdin.end(sql);
  });
}

const literal = (value) => {
  if (value === null || value === undefined) return 'null';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const tag = `$v${randomBytes(6).toString('hex')}$`;
  return `${tag}${text}${tag}`;
};

export async function loadAuthenticatedBackup(backupDir, encryptionKeys) {
  const dir = resolve(backupDir);
  const id = basename(dir).toLowerCase();
  const safeDir = await resolveBackupDirectory(
    `plateform-backup://${id}/manifest.json#database`,
    dirname(dir),
    id,
  );
  const manifestText = await readFile(join(safeDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  if (String(manifest.backup_id).toLowerCase() !== id)
    throw new Error('BACKUP_MANIFEST_ID_MISMATCH');
  if (
    manifest.format_version !== 2 ||
    manifest.manifest_auth?.algorithm !== 'HMAC-SHA256' ||
    manifest.manifest_auth?.file !== 'manifest.hmac'
  )
    throw new Error('BACKUP_MANIFEST_AUTH_REQUIRED');
  const encryptionKey = resolveEncryptionKey(encryptionKeys, manifest.encryption_key_id);
  verifyHmacSha256Text(
    manifestText,
    encryptionKey,
    await readFile(await resolveBackupArtifact(safeDir, 'manifest.hmac'), 'utf8'),
  );
  return { id, dir: safeDir, manifest, manifestText, encryptionKey };
}

async function decryptDatabaseArtifacts(backup, dbDir) {
  const { manifest, dir, encryptionKey } = backup;
  const files = {};
  const wanted = [
    ...['roles.sql', 'schema.sql', 'data.sql'].map((name) => [
      name,
      manifest.components?.database?.find((row) => row.file === `${name}.enc`),
      name.split('.')[0],
    ]),
    ...[
      ['history_schema.sql', 'historySchema'],
      ['history_data.sql', 'historyData'],
    ].map(([name, key]) => [
      name,
      manifest.components?.migrations?.files?.find((row) => row.file === `${name}.enc`),
      key,
    ]),
  ];
  for (const [name, meta, key] of wanted) {
    if (!meta) throw new Error(`BACKUP_ARTIFACT_MISSING:${name}`);
    const target = join(dbDir, name);
    await decryptVerified(await resolveBackupArtifact(dir, meta.file), target, encryptionKey, meta);
    files[key] = target;
  }
  return files;
}

export async function disasterRestore(config, createClient) {
  if (!config.operatorId) throw new Error('DISASTER_RESTORE_OPERATOR_REQUIRED');
  const backup = await loadAuthenticatedBackup(config.backupDir, config.encryptionKeys);
  const { manifest } = backup;
  const copyProof = await directoryProof(backup.dir);

  const occupied = parseTargetOccupancy(
    await psql(config, TARGET_OCCUPANCY_SQL, 'RESTORE_TARGET_QUERY_FAILED'),
  );
  if (occupied) throw new Error('RESTORE_TARGET_NOT_EMPTY');
  if (!(await targetStorageEmpty(config, createClient)))
    throw new Error('RESTORE_TARGET_STORAGE_NOT_EMPTY');

  const dbDir = join(config.temp, 'database');
  await mkdir(dbDir, { recursive: true, mode: 0o700 });
  const files = await decryptDatabaseArtifacts(backup, dbDir);
  await restoreDatabase(config, files);
  await restoreManagedOverlay(config, manifest, backup.dir, dbDir, backup.encryptionKey);
  await quiesceTargetAutomation(config);
  await sanitizeRestoredSecurityState(config);
  await restoreStorage(
    config,
    manifest,
    backup.dir,
    config.temp,
    createClient,
    backup.encryptionKey,
  );

  const db = await verifyDatabase(config);
  const verification = {
    ...db,
    ...(await verifyManagedSurface(config, manifest)),
    ...(await verifyMigrationHistory(config, {
      count: manifest.components.migrations.count,
      latest_version: manifest.components.migrations.latest_version,
      aggregate_sha256: manifest.components.migrations.aggregate_sha256,
    })),
    ...(await verifyPrivateState(config, manifest.components.private_state)),
    ...(await verifyStorageMetadata(
      config.psql,
      config.targetDatabaseUrl,
      manifest.components.storage.metadata_fingerprint,
    )),
    auth: db.auth === true && Number(db.auth_user_count) === manifest.components.auth.user_count,
    storage: await verifyStorage(config, manifest, createClient),
    manifest: true,
    manifest_auth: true,
    restored_from_copy_sha256: copyProof.aggregateSha256,
  };
  const failed = DISASTER_RESTORE_GATES.filter((key) => verification[key] !== true);
  if (failed.length) {
    const error = new Error(`RESTORE_VERIFICATION_FAILED:${failed.join(',')}`);
    error.verification = verification;
    throw error;
  }

  const row = JSON.parse(
    (await psql(
      config,
      `select json_build_object('status',status,'lease',lease_token) from public.backup_metadata where id=${literal(backup.id)}::uuid`,
      'DISASTER_RESTORE_QUERY_FAILED',
    )) || 'null',
  );
  if (!row) throw new Error('DISASTER_RESTORE_BACKUP_ROW_MISSING');
  const encryptedFiles = [
    ...manifest.components.database,
    ...manifest.components.migrations.files,
    ...(manifest.components.managed_overlay?.files ?? []),
    ...manifest.components.storage.objects,
  ];
  const backupVerification = {
    database: true,
    migrations: true,
    auth: true,
    private_state: true,
    storage: true,
    storage_metadata: true,
    replica: true,
    replica_file_count: copyProof.fileCount,
    replica_size_bytes: copyProof.sizeBytes,
    replica_hash: copyProof.aggregateSha256,
    manifest: true,
    manifest_auth: true,
    managed_overlay: true,
    security_surface: true,
  };
  const registration = JSON.parse(
    await psql(
      config,
      `begin;
set local role service_role;
set local request.jwt.claims to '{"role":"service_role"}';
select public.record_disaster_restore(
  ${literal(backup.id)}::uuid,${literal(row.lease)}::uuid,${literal(manifest)}::jsonb,
  ${literal(sha256Text(backup.manifestText))},${literal(backupVerification)}::jsonb,
  ${encryptedFiles.reduce((sum, file) => sum + Number(file.size_bytes), 0)},
  ${manifest.components.storage.objects.length},${literal(manifest.encryption_key_id)},
  ${literal(verification)}::jsonb,${literal(config.targetReference)},${literal(config.operatorId)}::uuid);
commit;`,
      'DISASTER_RESTORE_REGISTRATION_FAILED',
    ),
  );
  return {
    backupId: backup.id,
    restoredFrom: copyProof,
    verification,
    registration,
    schedulesPending: manifest.components.managed_overlay.schedules,
  };
}

// Cutover step: re-arm the pg_cron schedules captured in the backup. Never
// called by disasterRestore() itself.
export async function activateSchedules(config) {
  const backup = await loadAuthenticatedBackup(config.backupDir, config.encryptionKeys);
  const meta = backup.manifest.components?.managed_overlay?.files?.find(
    (row) => row.file === 'schedules.sql.enc',
  );
  if (!meta) throw new Error('BACKUP_ARTIFACT_MISSING:schedules.sql');
  await mkdir(config.temp, { recursive: true, mode: 0o700 });
  const target = join(config.temp, 'schedules.sql');
  await decryptVerified(
    await resolveBackupArtifact(backup.dir, meta.file),
    target,
    backup.encryptionKey,
    meta,
  );
  await applyManagedOverlay(config.psql, config.targetDatabaseUrl, target);
  const counts = await managedOverlayCounts(config.psql, config.targetDatabaseUrl);
  return {
    expected: backup.manifest.components.managed_overlay.schedule_count,
    active: Number(counts.schedule_count),
  };
}
