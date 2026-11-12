import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !resolve(path).startsWith(`${resolve(root)}${sep}..${sep}`)
  );
}

export function expectedBackupDirectory(backupRoot, id, databaseReference) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id))
  )
    throw new Error('RETENTION_INVALID_BACKUP_ID');
  let ref;
  try {
    ref = new URL(String(databaseReference));
  } catch {
    throw new Error('RETENTION_INVALID_REFERENCE');
  }
  if (ref.hash !== '#database') throw new Error('RETENTION_INVALID_REFERENCE');

  const root = resolve(backupRoot);
  const normalizedId = String(id).toLowerCase();
  const expected = join(root, normalizedId);
  const manifest = join(expected, 'manifest.json');
  if (ref.protocol === 'plateform-backup:') {
    if (
      ref.username ||
      ref.password ||
      ref.port ||
      ref.search ||
      ref.hostname.toLowerCase() !== normalizedId ||
      ref.pathname !== '/manifest.json'
    )
      throw new Error('RETENTION_INVALID_REFERENCE');
  } else if (ref.protocol === 'file:') {
    if (ref.username || ref.password || ref.host) throw new Error('RETENTION_INVALID_REFERENCE');
    const referenced = resolve(decodeURIComponent(ref.pathname));
    if (referenced !== manifest) throw new Error('RETENTION_REFERENCE_OUTSIDE_ROOT');
  } else {
    throw new Error('RETENTION_INVALID_REFERENCE');
  }
  if (!inside(root, expected)) throw new Error('RETENTION_REFERENCE_OUTSIDE_ROOT');
  return expected;
}

export async function purgeBackupDirectory(backupRoot, id, databaseReference) {
  const expected = expectedBackupDirectory(backupRoot, id, databaseReference);
  let rootReal;
  try {
    rootReal = await realpath(backupRoot);
  } catch {
    throw new Error('RETENTION_ROOT_UNAVAILABLE');
  }

  let info;
  try {
    info = await lstat(expected);
  } catch (error) {
    if (error?.code === 'ENOENT') return { directory: expected, alreadyMissing: true };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('RETENTION_UNSAFE_DIRECTORY');

  const directoryReal = await realpath(expected);
  if (!inside(rootReal, directoryReal) || directoryReal !== join(rootReal, String(id)))
    throw new Error('RETENTION_REFERENCE_OUTSIDE_ROOT');

  const parent = await lstat(dirname(directoryReal));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('RETENTION_UNSAFE_ROOT');

  await rm(directoryReal, { recursive: true, force: false });
  return { directory: directoryReal, alreadyMissing: false };
}

export async function purgeBackupCopies(backupRoot, replicaRoot, id, databaseReference) {
  const primary = await purgeBackupDirectory(backupRoot, id, databaseReference);
  const replica = await purgeBackupDirectory(replicaRoot, id, databaseReference);
  return { primary, replica };
}
