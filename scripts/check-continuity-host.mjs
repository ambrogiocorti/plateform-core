import { assertSupabaseServerKey } from '../tools/continuity/server-key.mjs';
import { access, constants, mkdir, lstat, realpath, stat, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const failures = [];
const warnings = [];
const details = {};

const toolchainLockText = await readFile(
  new URL('../deploy/continuity/toolchain.lock.env', import.meta.url),
  'utf8',
);
const toolchainLock = Object.fromEntries(
  toolchainLockText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);
const expectedSupabaseCli = toolchainLock.PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION;
const minimumPsqlMajor = Number(toolchainLock.PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR || 0);

function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1, 4).map((part) => Number(part ?? 0)) : null;
}
function atLeast(actual, minimum) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}
function command(name, args = ['--version']) {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 20_000 });
  if (result.error) {
    failures.push(`COMMAND_MISSING:${name}`);
    return null;
  }
  if (result.status !== 0) {
    failures.push(`COMMAND_FAILED:${name}`);
    return null;
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) failures.push(`ENV_MISSING:${name}`);
  return value || '';
}
function validHttps(name, raw) {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      failures.push(`ENV_INVALID:${name}`);
  } catch {
    failures.push(`ENV_INVALID:${name}`);
  }
}
function validDatabaseUrl(name, raw) {
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username)
      failures.push(`ENV_INVALID:${name}`);
  } catch {
    failures.push(`ENV_INVALID:${name}`);
  }
}

function canonicalApiProjectRef(name, raw) {
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    const match = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    if (!match) {
      failures.push(`ENV_CANONICAL_PROJECT_URL_REQUIRED:${name}`);
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}
function databaseProjectRef(name, raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostMatch = url.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    const userMatch = decodeURIComponent(url.username).match(/^postgres\.([a-z0-9]+)$/i);
    const refs = [hostMatch?.[1], userMatch?.[1]?.toLowerCase()].filter(Boolean);
    if (!refs.length || new Set(refs).size !== 1) {
      failures.push(`ENV_DB_PROJECT_REF_UNDETECTABLE:${name}`);
      return null;
    }
    return refs[0];
  } catch {
    return null;
  }
}

function pathsNested(a, b) {
  const left = resolve(a),
    right = resolve(b);
  if (left === right) return true;
  const rel1 = relative(left, right),
    rel2 = relative(right, left);
  const inside = (rel) => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
  return inside(rel1) || inside(rel2);
}
async function validateRoot(name, raw, detailKey) {
  if (raw && !isAbsolute(raw)) {
    failures.push(`ENV_INVALID:${name}`);
    details[detailKey] = raw;
    return null;
  }
  const resolved = resolve(raw || './.local/invalid');
  details[detailKey] = resolved;
  try {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(resolved)) !== resolved)
      failures.push(`${name}_UNSAFE`);
  } catch {
    failures.push(`${name}_NOT_WRITABLE`);
  }
  return resolved;
}

function validKey(raw) {
  if (!raw) return;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, ''))
    failures.push('ENV_INVALID:PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64');
}

const nodeVersion = parseVersion(process.versions.node);
details.node = process.versions.node;
if (!nodeVersion || !atLeast(nodeVersion, [24, 13, 0])) failures.push('NODE_VERSION_UNSUPPORTED');

const supabaseBin = process.env.SUPABASE_CLI_BIN?.trim() || 'supabase';
const psqlBin = process.env.PSQL_BIN?.trim() || 'psql';
const dockerBin = process.env.DOCKER_BIN?.trim() || 'docker';

details.supabase = command(supabaseBin);
if (details.supabase) {
  details.supabase_dump_help = command(supabaseBin, ['db', 'dump', '--help']) ? 'OK' : null;
  const match = details.supabase.match(/(\d+\.\d+\.\d+)/);
  details.supabase_version = match?.[1] ?? null;
  details.supabase_expected_version = expectedSupabaseCli || null;
  if (expectedSupabaseCli && details.supabase_version !== expectedSupabaseCli)
    failures.push('SUPABASE_CLI_VERSION_MISMATCH');
}
details.psql = command(psqlBin);
if (details.psql) {
  const match = details.psql.match(/(\d+)(?:\.\d+)?/);
  details.psql_major = match ? Number(match[1]) : null;
  details.psql_minimum_major = minimumPsqlMajor || null;
  if (!details.psql_major || (minimumPsqlMajor && details.psql_major < minimumPsqlMajor))
    failures.push('PSQL_VERSION_UNSUPPORTED');
}

details.docker = command(dockerBin, ['info', '--format', '{{json .ServerVersion}}']);
if (details.docker) {
  const securityOptions = command(dockerBin, ['info', '--format', '{{json .SecurityOptions}}']);
  details.docker_security_options = securityOptions;
  const rootless = /rootless/i.test(securityOptions || '');
  details.docker_rootless = rootless;
  if (!rootless && process.env.PLATEFORM_ALLOW_ROOTFUL_DOCKER !== 'true') {
    failures.push('DOCKER_NOT_ROOTLESS');
  } else if (!rootless) {
    warnings.push('ROOTFUL_DOCKER_EXPLICITLY_ALLOWED');
  }
}

const supabaseUrl = required('SUPABASE_URL');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
if (serviceRoleKey) {
  try {
    assertSupabaseServerKey('SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'ENV_INVALID:SUPABASE_SERVICE_ROLE_KEY');
  }
}
const databaseUrl = required('SUPABASE_DB_URL');
const encryptionKey = required('PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64');
const encryptionKeyId = required('PLATEFORM_BACKUP_ENCRYPTION_KEY_ID');
const rootValue = required('PLATEFORM_BACKUP_ROOT');
const replicaRootValue = required('PLATEFORM_BACKUP_REPLICA_ROOT');
validHttps('SUPABASE_URL', supabaseUrl);
validDatabaseUrl('SUPABASE_DB_URL', databaseUrl);
const sourceProjectRef = canonicalApiProjectRef('SUPABASE_URL', supabaseUrl);
const databaseRef = databaseProjectRef('SUPABASE_DB_URL', databaseUrl);
if (sourceProjectRef && databaseRef && sourceProjectRef !== databaseRef)
  failures.push('PROJECT_REF_MISMATCH:SUPABASE_DB_URL');
details.source_project_ref = sourceProjectRef;
details.database_project_ref = databaseRef;
validKey(encryptionKey);
if (encryptionKeyId && !/^[A-Za-z0-9._:-]{3,160}$/.test(encryptionKeyId))
  failures.push('ENV_INVALID:PLATEFORM_BACKUP_ENCRYPTION_KEY_ID');

const root = await validateRoot('PLATEFORM_BACKUP_ROOT', rootValue, 'backup_root');
const replicaRoot = await validateRoot(
  'PLATEFORM_BACKUP_REPLICA_ROOT',
  replicaRootValue,
  'backup_replica_root',
);
if (root && replicaRoot && rootValue && replicaRootValue && !pathsNested(root, replicaRoot)) {
  try {
    const [primaryStat, replicaStat] = await Promise.all([stat(root), stat(replicaRoot)]);
    const sameDevice = primaryStat.dev === replicaStat.dev;
    details.replica_same_device = sameDevice;
    if (sameDevice && process.env.PLATEFORM_ALLOW_SAME_DEVICE_REPLICA !== 'true')
      failures.push('BACKUP_REPLICA_SAME_DEVICE');
    else if (sameDevice) warnings.push('BACKUP_REPLICA_SAME_DEVICE_EXPLICITLY_ALLOWED');
  } catch {
    failures.push('BACKUP_REPLICA_STAT_FAILED');
  }
} else if (root && replicaRoot && rootValue && replicaRootValue) {
  failures.push('BACKUP_REPLICA_ROOT_NOT_INDEPENDENT');
}

const status = failures.length ? 'NOT_READY' : warnings.length ? 'READY_WITH_WARNINGS' : 'READY';
console.log(
  JSON.stringify(
    { status, failures: [...new Set(failures)], warnings: [...new Set(warnings)], details },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
