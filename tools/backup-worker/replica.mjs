import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { assertSafeBackupRoot } from './filesystem.mjs';
import { sha256File, sha256Text } from './crypto.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}

export function assertDistinctBackupRoots(primaryRoot, replicaRoot) {
  const primary = resolve(primaryRoot),
    replica = resolve(replicaRoot);
  if (primary === replica || inside(primary, replica) || inside(replica, primary))
    throw new Error('BACKUP_REPLICA_ROOT_NOT_INDEPENDENT');
  return { primary, replica };
}

export async function checkBackupRoots(primaryRoot, replicaRoot, allowSameDevice = false) {
  const roots = assertDistinctBackupRoots(primaryRoot, replicaRoot);
  const primary = await assertSafeBackupRoot(roots.primary);
  const replica = await assertSafeBackupRoot(roots.replica);
  const [p, r] = await Promise.all([stat(primary), stat(replica)]);
  const sameDevice = p.dev === r.dev;
  if (sameDevice && !allowSameDevice) throw new Error('BACKUP_REPLICA_SAME_DEVICE');
  return { primary, replica, sameDevice };
}

async function filesUnder(root, current = root, out = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('BACKUP_REPLICA_SOURCE_SYMLINK');
    if (info.isDirectory()) await filesUnder(root, path, out);
    else if (info.isFile()) out.push(relative(root, path).split(sep).join('/'));
    else throw new Error('BACKUP_REPLICA_SOURCE_UNSUPPORTED');
  }
  return out;
}

async function directoryProof(root) {
  const relativeFiles = (await filesUnder(root)).sort();
  if (!relativeFiles.includes('manifest.json')) throw new Error('BACKUP_REPLICA_MANIFEST_MISSING');
  const verified = [];
  let sizeBytes = 0;
  for (const rel of relativeFiles) {
    const path = join(root, ...rel.split('/'));
    const info = await stat(path);
    const hash = await sha256File(path);
    verified.push(`${rel}|${info.size}|${hash}`);
    sizeBytes += info.size;
  }
  return {
    fileCount: verified.length,
    aggregateSha256: sha256Text(verified.join('\n')),
    sizeBytes,
  };
}

async function existingReplicaProof(root, id) {
  const target = join(root, id);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target)
    throw new Error('BACKUP_REPLICA_DESTINATION_UNSAFE');
  return { directory: target, ...(await directoryProof(target)) };
}

async function removeExistingSafe(root, id) {
  const target = join(root, id);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target)
      throw new Error('BACKUP_REPLICA_DESTINATION_UNSAFE');
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

export async function removeReplicaDirectory(replicaRoot, value) {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new Error('BACKUP_REPLICA_INVALID_ID');
  const root = await assertSafeBackupRoot(replicaRoot);
  await removeExistingSafe(root, id);
}

export async function replicateBackupDirectory(sourceDir, replicaRoot, value) {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new Error('BACKUP_REPLICA_INVALID_ID');
  const source = resolve(sourceDir);
  const sourceInfo = await lstat(source);
  if (
    !sourceInfo.isDirectory() ||
    sourceInfo.isSymbolicLink() ||
    (await realpath(source)) !== source
  )
    throw new Error('BACKUP_REPLICA_SOURCE_UNSAFE');
  if (source.split(sep).at(-1)?.toLowerCase() !== id)
    throw new Error('BACKUP_REPLICA_SOURCE_ID_MISMATCH');
  const root = await assertSafeBackupRoot(replicaRoot);
  const destination = join(root, id);
  const partial = join(root, `.${id}.${randomUUID()}.partial`);
  const sourceProof = await directoryProof(source);
  const existing = await existingReplicaProof(root, id);
  if (existing) {
    if (
      existing.fileCount === sourceProof.fileCount &&
      existing.sizeBytes === sourceProof.sizeBytes &&
      existing.aggregateSha256 === sourceProof.aggregateSha256
    )
      return existing;
    throw new Error('BACKUP_REPLICA_IMMUTABLE_CONFLICT');
  }
  await mkdir(partial, { mode: 0o700 });
  try {
    const relativeFiles = (await filesUnder(source)).sort();
    const verified = [];
    for (const rel of relativeFiles) {
      const sourcePath = join(source, ...rel.split('/'));
      const targetPath = join(partial, ...rel.split('/'));
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, 0o600);
      const [sourceStat, targetStat, sourceHash, targetHash] = await Promise.all([
        stat(sourcePath),
        stat(targetPath),
        sha256File(sourcePath),
        sha256File(targetPath),
      ]);
      if (sourceStat.size !== targetStat.size || sourceHash !== targetHash)
        throw new Error('BACKUP_REPLICA_VERIFY_FAILED');
      verified.push(`${rel}|${targetStat.size}|${targetHash}`);
    }
    await rename(partial, destination);
    if ((await realpath(destination)) !== destination)
      throw new Error('BACKUP_REPLICA_DESTINATION_UNSAFE');
    return {
      directory: destination,
      fileCount: verified.length,
      aggregateSha256: sha256Text(verified.join('\n')),
      sizeBytes: (
        await Promise.all(relativeFiles.map((rel) => stat(join(destination, ...rel.split('/')))))
      ).reduce((sum, row) => sum + row.size, 0),
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
