import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function backupId(value) {
  const id = String(value ?? '');
  if (!UUID.test(id)) throw new Error('BACKUP_PATH_INVALID_ID');
  return id;
}

const COMPONENTS = new Set(['database', 'auth', 'storage']);

export function backupArtifactReference(value, component) {
  const id = backupId(value).toLowerCase();
  const part = String(component ?? '');
  if (!COMPONENTS.has(part)) throw new Error('BACKUP_REFERENCE_INVALID_COMPONENT');
  return `plateform-backup://${id}/manifest.json#${part}`;
}

export async function assertSafeBackupRoot(root) {
  const expected = resolve(root);
  let info;
  try {
    info = await lstat(expected);
  } catch {
    throw new Error('BACKUP_ROOT_UNAVAILABLE');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('BACKUP_ROOT_UNSAFE');
  const actual = await realpath(expected);
  if (actual !== expected) throw new Error('BACKUP_ROOT_NOT_CANONICAL');
  return expected;
}

export async function prepareBackupDirectory(root, value) {
  const safeRoot = await assertSafeBackupRoot(root);
  const id = backupId(value);
  const expected = join(safeRoot, id);
  try {
    const info = await lstat(expected);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('BACKUP_DIRECTORY_UNSAFE');
    const actual = await realpath(expected);
    if (actual !== expected) throw new Error('BACKUP_DIRECTORY_UNSAFE');
    await rm(expected, { recursive: true, force: false });
  } catch (error) {
    if (error?.message === 'BACKUP_DIRECTORY_UNSAFE') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(expected, { recursive: false, mode: 0o700 });
  const created = await lstat(expected);
  if (!created.isDirectory() || created.isSymbolicLink() || (await realpath(expected)) !== expected)
    throw new Error('BACKUP_DIRECTORY_UNSAFE');
  return expected;
}

export async function resolveBackupDirectory(reference, root, value) {
  const safeRoot = await assertSafeBackupRoot(root);
  const id = backupId(value).toLowerCase();
  let url;
  try {
    url = new URL(String(reference));
  } catch {
    throw new Error('BACKUP_REFERENCE_INVALID');
  }
  const expectedDir = join(safeRoot, id);
  const expectedManifest = join(expectedDir, 'manifest.json');

  if (url.protocol === 'plateform-backup:') {
    if (
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hostname.toLowerCase() !== id ||
      url.pathname !== '/manifest.json' ||
      url.hash !== '#database'
    )
      throw new Error('BACKUP_REFERENCE_UNSUPPORTED');
  } else if (url.protocol === 'file:') {
    if (url.username || url.password || url.host || url.hash !== '#database')
      throw new Error('BACKUP_REFERENCE_UNSUPPORTED');
    let referenced;
    try {
      referenced = resolve(fileURLToPath(url));
    } catch {
      throw new Error('BACKUP_REFERENCE_INVALID');
    }
    if (referenced !== expectedManifest) throw new Error('BACKUP_REFERENCE_OUTSIDE_ROOT');
  } else {
    throw new Error('BACKUP_REFERENCE_UNSUPPORTED');
  }

  let dirInfo, manifestInfo;
  try {
    dirInfo = await lstat(expectedDir);
    manifestInfo = await lstat(expectedManifest);
  } catch {
    throw new Error('BACKUP_ARTIFACT_UNAVAILABLE');
  }
  if (
    !dirInfo.isDirectory() ||
    dirInfo.isSymbolicLink() ||
    (await realpath(expectedDir)) !== expectedDir
  )
    throw new Error('BACKUP_DIRECTORY_UNSAFE');
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('BACKUP_MANIFEST_UNSAFE');
  return expectedDir;
}

export async function resolveBackupArtifact(backupDir, relativePath) {
  const base = resolve(String(backupDir));
  const raw = String(relativePath ?? '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/'))
    throw new Error('BACKUP_ARTIFACT_PATH_INVALID');
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('BACKUP_ARTIFACT_PATH_INVALID');
  const expected = resolve(base, ...parts);
  const rel = relative(base, expected);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('BACKUP_ARTIFACT_PATH_OUTSIDE_ROOT');
  let info;
  try {
    info = await lstat(expected);
  } catch {
    throw new Error('BACKUP_ARTIFACT_UNAVAILABLE');
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('BACKUP_ARTIFACT_UNSAFE');
  const actual = await realpath(expected);
  if (actual !== expected) throw new Error('BACKUP_ARTIFACT_UNSAFE');
  return expected;
}
