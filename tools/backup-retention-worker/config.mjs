import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertSafeBackupRoot } from '../backup-worker/filesystem.mjs';
import { checkBackupRoots } from '../backup-worker/replica.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}

function httpsUrl(name) {
  const raw = required(name);
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`CONFIG_INVALID:${name}`);
  }
  if (value.protocol !== 'https:' || value.username || value.password || value.hash)
    throw new Error(`CONFIG_INVALID:${name}`);
  return value.toString().replace(/\/$/, '');
}

export function loadConfig() {
  const root = required('PLATEFORM_BACKUP_ROOT');
  if (!isAbsolute(root)) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_ROOT');
  const replicaRoot = required('PLATEFORM_BACKUP_REPLICA_ROOT');
  if (!isAbsolute(replicaRoot)) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_REPLICA_ROOT');
  return {
    supabaseUrl: httpsUrl('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    backupRoot: resolve(root),
    replicaRoot: resolve(replicaRoot),
    leaseSeconds: Number(process.env.PLATEFORM_RETENTION_LEASE_SECONDS || 300),
  };
}

export async function checkPrerequisites(config) {
  if (
    !Number.isInteger(config.leaseSeconds) ||
    config.leaseSeconds < 60 ||
    config.leaseSeconds > 1800
  )
    throw new Error('CONFIG_INVALID:PLATEFORM_RETENTION_LEASE_SECONDS');
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.replicaRoot, { recursive: true, mode: 0o700 });
  await access(config.backupRoot, constants.R_OK | constants.W_OK);
  await access(config.replicaRoot, constants.R_OK | constants.W_OK);
  await assertSafeBackupRoot(config.backupRoot);
  await assertSafeBackupRoot(config.replicaRoot);
  const roots = await checkBackupRoots(config.backupRoot, config.replicaRoot, true);
  return {
    backupRoot: config.backupRoot,
    replicaRoot: config.replicaRoot,
    replicaSameDevice: roots.sameDevice,
    leaseSeconds: config.leaseSeconds,
  };
}
