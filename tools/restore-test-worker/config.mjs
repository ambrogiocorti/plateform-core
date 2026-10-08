import { assertSupabaseServerKey } from '../continuity/server-key.mjs';
import { loadEncryptionKeyring } from '../backup-worker/keyring.mjs';
import { access, mkdtemp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { assertSafeBackupRoot } from '../backup-worker/filesystem.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_REQUIRED:${name}`);
  return value;
}
function url(name) {
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
function projectRef(endpoint, name) {
  const host = new URL(endpoint).hostname.toLowerCase();
  const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (!match) throw new Error(`CONFIG_CANONICAL_PROJECT_URL_REQUIRED:${name}`);
  return match[1];
}
function databaseProjectRef(raw, name) {
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`CONFIG_INVALID:${name}`);
  }
  if (!['postgres:', 'postgresql:'].includes(value.protocol) || !value.hostname || !value.username)
    throw new Error(`CONFIG_INVALID:${name}`);
  const hostMatch = value.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  const userMatch = decodeURIComponent(value.username).match(/^postgres\.([a-z0-9]+)$/i);
  const refs = [hostMatch?.[1], userMatch?.[1]?.toLowerCase()].filter(Boolean);
  if (!refs.length || new Set(refs).size !== 1)
    throw new Error(`CONFIG_DB_PROJECT_REF_UNDETECTABLE:${name}`);
  return refs[0];
}
async function commandOk(command, args) {
  await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', (e) =>
      reject(new Error(`PREREQUISITE_MISSING:${command}:${e.code ?? e.message}`)),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolveResult()
        : reject(new Error(`PREREQUISITE_FAILED:${command}:${code}:${stderr.slice(0, 240)}`)),
    );
  });
}

async function commandOutput(command, args) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', (e) =>
      reject(new Error(`PREREQUISITE_MISSING:${command}:${e.code ?? e.message}`)),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolveResult(stdout)
        : reject(new Error(`PREREQUISITE_FAILED:${command}:${code}:${stderr.slice(0, 240)}`)),
    );
  });
}
export function loadConfig() {
  const sourceUrl = url('SUPABASE_URL');
  const targetUrl = url('PLATEFORM_RESTORE_TEST_SUPABASE_URL');
  const targetDatabaseUrl = required('PLATEFORM_RESTORE_TEST_DB_URL');
  const root = required('PLATEFORM_BACKUP_ROOT');
  if (!isAbsolute(root)) throw new Error('CONFIG_INVALID:PLATEFORM_BACKUP_ROOT');
  const sourceProjectRef = projectRef(sourceUrl, 'SUPABASE_URL');
  const targetProjectRef = projectRef(targetUrl, 'PLATEFORM_RESTORE_TEST_SUPABASE_URL');
  if (process.env.PLATEFORM_RESTORE_TEST_ALLOW_DESTRUCTIVE !== 'true')
    throw new Error('RESTORE_TEST_DESTRUCTIVE_ACK_REQUIRED');
  if (sourceProjectRef === targetProjectRef) throw new Error('RESTORE_TARGET_MUST_BE_ISOLATED');
  if (databaseProjectRef(targetDatabaseUrl, 'PLATEFORM_RESTORE_TEST_DB_URL') !== targetProjectRef)
    throw new Error('RESTORE_TEST_DB_PROJECT_REF_MISMATCH');
  if (required('PLATEFORM_RESTORE_TEST_CONFIRM_PROJECT_REF') !== targetProjectRef)
    throw new Error('RESTORE_TEST_TARGET_CONFIRMATION_MISMATCH');
  return {
    sourceUrl,
    sourceServiceRoleKey: assertSupabaseServerKey(
      'SUPABASE_SERVICE_ROLE_KEY',
      required('SUPABASE_SERVICE_ROLE_KEY'),
    ),
    backupRoot: resolve(root),
    encryptionKeys: loadEncryptionKeyring(
      required('PLATEFORM_BACKUP_ENCRYPTION_KEY_ID'),
      required('PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64'),
    ),
    targetUrl,
    targetServiceRoleKey: assertSupabaseServerKey(
      'PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY',
      required('PLATEFORM_RESTORE_TEST_SERVICE_ROLE_KEY'),
    ),
    targetDatabaseUrl,
    targetProjectRef,
    psql: process.env.PSQL_BIN?.trim() || 'psql',
    leaseSeconds: Number(process.env.PLATEFORM_RESTORE_TEST_LEASE_SECONDS || 1800),
  };
}
export async function checkPrerequisites(config) {
  if (
    !Number.isInteger(config.leaseSeconds) ||
    config.leaseSeconds < 60 ||
    config.leaseSeconds > 1800
  )
    throw new Error('CONFIG_INVALID:PLATEFORM_RESTORE_TEST_LEASE_SECONDS');
  await access(config.backupRoot, constants.R_OK);
  await assertSafeBackupRoot(config.backupRoot);
  await commandOk(config.psql, ['--version']);
  const occupied = (
    await commandOutput(config.psql, [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      config.targetDatabaseUrl,
      '--command',
      "select (to_regclass('public.restaurant_profile') is not null)::text;",
    ])
  ).trim();
  const temp = await mkdtemp(`${tmpdir()}/plateform-restore-test-`);
  return {
    psql: config.psql,
    targetProjectRef: config.targetProjectRef,
    temp,
    targetOccupied: occupied === 'true' || occupied === 't',
  };
}
