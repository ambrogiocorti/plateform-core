import { assertSupabaseServerKey } from '../continuity/server-key.mjs';
import { access, mkdir } from 'node:fs/promises';
import { assertSafeBackupRoot } from './filesystem.mjs';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';

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

function databaseUrl(name) {
  const raw = required(name);
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`CONFIG_INVALID:${name}`);
  }
  if (!['postgres:', 'postgresql:'].includes(value.protocol) || !value.hostname || !value.username)
    throw new Error(`CONFIG_INVALID:${name}`);
  return raw;
}

function apiProjectRef(endpoint, name = 'SUPABASE_URL') {
  const host = new URL(endpoint).hostname.toLowerCase();
  const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (!match) throw new Error(`CONFIG_CANONICAL_PROJECT_URL_REQUIRED:${name}`);
  return match[1];
}

function databaseProjectRef(raw, name = 'SUPABASE_DB_URL') {
  const value = new URL(raw);
  const hostMatch = value.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  const userMatch = decodeURIComponent(value.username).match(/^postgres\.([a-z0-9]+)$/i);
  const refs = [hostMatch?.[1], userMatch?.[1]?.toLowerCase()].filter(Boolean);
  if (!refs.length || new Set(refs).size !== 1)
    throw new Error(`CONFIG_DB_PROJECT_REF_UNDETECTABLE:${name}`);
  return refs[0];
}

function key32(name) {
  const raw = required(name);
  const value = Buffer.from(raw, 'base64');
  if (value.length !== 32 || value.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, ''))
    throw new Error(`CONFIG_INVALID:${name}`);
  return value;
}

function commandOutput(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) =>
      reject(new Error(`PREREQUISITE_MISSING:${command}:${error.code ?? error.message}`)),
    );
    child.once('exit', (code) => {
      if (code === 0) resolveResult(`${stdout}${stderr}`.trim());
      else reject(new Error(`PREREQUISITE_FAILED:${command}:${code}:${stderr.slice(0, 240)}`));
    });
  });
}

export function loadConfig() {
  const root = required('PLATEFORM_BACKUP_ROOT');
  if (!isAbsolute(root)) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_ROOT');
  const replicaRoot = required('PLATEFORM_BACKUP_REPLICA_ROOT');
  if (!isAbsolute(replicaRoot)) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_REPLICA_ROOT');
  const keyId = required('PLATEFORM_BACKUP_ENCRYPTION_KEY_ID');
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(keyId))
    throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_ENCRYPTION_KEY_ID');
  const supabaseUrl = httpsUrl('SUPABASE_URL');
  const database = databaseUrl('SUPABASE_DB_URL');
  const sourceProjectRef = apiProjectRef(supabaseUrl);
  if (databaseProjectRef(database) !== sourceProjectRef)
    throw new Error('CONFIG_PROJECT_REF_MISMATCH:SUPABASE_DB_URL');
  return {
    supabaseUrl,
    sourceProjectRef,
    serviceRoleKey: assertSupabaseServerKey(
      'SUPABASE_SERVICE_ROLE_KEY',
      required('SUPABASE_SERVICE_ROLE_KEY'),
    ),
    databaseUrl: database,
    backupRoot: resolve(root),
    replicaRoot: resolve(replicaRoot),
    encryptionKey: key32('PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64'),
    encryptionKeyId: keyId,
    supabaseCli: process.env.SUPABASE_CLI_BIN?.trim() || 'supabase',
    psql: process.env.PSQL_BIN?.trim() || 'psql',
    docker: process.env.DOCKER_BIN?.trim() || 'docker',
    allowRootfulDocker: process.env.PLATEFORM_ALLOW_ROOTFUL_DOCKER === 'true',
    allowSameDeviceReplica: process.env.PLATEFORM_ALLOW_SAME_DEVICE_REPLICA === 'true',
    leaseSeconds: Number(process.env.PLATEFORM_BACKUP_LEASE_SECONDS || 1800),
  };
}

export async function checkPrerequisites(config) {
  if (
    !Number.isInteger(config.leaseSeconds) ||
    config.leaseSeconds < 60 ||
    config.leaseSeconds > 1800
  )
    throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_LEASE_SECONDS');
  await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.replicaRoot, { recursive: true, mode: 0o700 });
  await assertSafeBackupRoot(config.backupRoot);
  await assertSafeBackupRoot(config.replicaRoot);
  await access(config.backupRoot, constants.R_OK | constants.W_OK);
  await access(config.replicaRoot, constants.R_OK | constants.W_OK);
  const { checkBackupRoots } = await import('./replica.mjs');
  const roots = await checkBackupRoots(
    config.backupRoot,
    config.replicaRoot,
    config.allowSameDeviceReplica,
  );
  await commandOutput(config.supabaseCli, ['--version']);
  await commandOutput(config.supabaseCli, ['db', 'dump', '--help']);
  await commandOutput(config.psql, ['--version']);
  const dockerVersion = await commandOutput(config.docker, [
    'info',
    '--format',
    '{{json .ServerVersion}}',
  ]);
  const dockerSecurity = await commandOutput(config.docker, [
    'info',
    '--format',
    '{{json .SecurityOptions}}',
  ]);
  const dockerRootless = /rootless/i.test(dockerSecurity);
  if (!dockerRootless && !config.allowRootfulDocker)
    throw new Error('PREREQUISITE_FAILED:DOCKER_NOT_ROOTLESS');
  return {
    cli: config.supabaseCli,
    psql: config.psql,
    docker: config.docker,
    dockerVersion,
    dockerRootless,
    backupRoot: config.backupRoot,
    replicaRoot: config.replicaRoot,
    replicaSameDevice: roots.sameDevice,
    encryptionKeyId: config.encryptionKeyId,
  };
}
