import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSafeBackupRoot,
  backupArtifactReference,
  prepareBackupDirectory,
  resolveBackupArtifact,
  resolveBackupDirectory,
} from '../tools/backup-worker/filesystem.mjs';

const temp = await mkdtemp(join(tmpdir(), 'plateform-backup-fs-'));
const root = join(temp, 'backups');
const outside = join(temp, 'outside');
const id = '123e4567-e89b-42d3-a456-426614174000';
try {
  await mkdir(root, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  if ((await assertSafeBackupRoot(root)) !== root) throw new Error('SAFE_ROOT');
  const first = await prepareBackupDirectory(root, id);
  await writeFile(join(first, 'partial.tmp'), 'partial');
  const second = await prepareBackupDirectory(root, id);
  await stat(join(second, 'partial.tmp')).then(
    () => {
      throw new Error('RETRY_NOT_CLEAN');
    },
    () => undefined,
  );
  const manifest = join(second, 'manifest.json');
  await writeFile(manifest, '{}');
  const ref = backupArtifactReference(id, 'database');
  if (ref !== `plateform-backup://${id}/manifest.json#database`)
    throw new Error('PORTABLE_REFERENCE_FORMAT');
  if ((await resolveBackupDirectory(ref, root, id)) !== second)
    throw new Error('RESOLVE_PORTABLE_VALID');
  const legacyRef = `${pathToFileURL(manifest).href}#database`;
  if ((await resolveBackupDirectory(legacyRef, root, id)) !== second)
    throw new Error('RESOLVE_LEGACY_VALID');
  const nested = join(second, 'storage', 'bucket');
  await mkdir(nested, { recursive: true, mode: 0o700 });
  const artifact = join(nested, 'file.enc');
  await writeFile(artifact, 'encrypted');
  if ((await resolveBackupArtifact(second, 'storage/bucket/file.enc')) !== artifact)
    throw new Error('ARTIFACT_RESOLVE_VALID');
  let traversalBlocked = false;
  try {
    await resolveBackupArtifact(second, '../outside/file.enc');
  } catch (error) {
    traversalBlocked =
      error.message === 'BACKUP_ARTIFACT_PATH_INVALID' ||
      error.message === 'BACKUP_ARTIFACT_PATH_OUTSIDE_ROOT';
  }
  if (!traversalBlocked) throw new Error('ARTIFACT_TRAVERSAL_NOT_BLOCKED');
  const artifactLink = join(nested, 'link.enc');
  await symlink(artifact, artifactLink);
  let artifactSymlinkBlocked = false;
  try {
    await resolveBackupArtifact(second, 'storage/bucket/link.enc');
  } catch (error) {
    artifactSymlinkBlocked = error.message === 'BACKUP_ARTIFACT_UNSAFE';
  }
  if (!artifactSymlinkBlocked) throw new Error('ARTIFACT_SYMLINK_NOT_BLOCKED');

  let outsideBlocked = false;
  try {
    await resolveBackupDirectory(
      `${pathToFileURL(join(outside, 'manifest.json')).href}#database`,
      root,
      id,
    );
  } catch (error) {
    outsideBlocked = String(error.message).startsWith('BACKUP_REFERENCE_OUTSIDE_ROOT');
  }
  if (!outsideBlocked) throw new Error('OUTSIDE_REFERENCE_NOT_BLOCKED');

  await rm(second, { recursive: true });
  await symlink(outside, second, 'dir');
  let symlinkBlocked = false;
  try {
    await prepareBackupDirectory(root, id);
  } catch (error) {
    symlinkBlocked = error.message === 'BACKUP_DIRECTORY_UNSAFE';
  }
  if (!symlinkBlocked) throw new Error('JOB_SYMLINK_NOT_BLOCKED');

  const rootLink = join(temp, 'backups-link');
  await symlink(root, rootLink, 'dir');
  let rootBlocked = false;
  try {
    await assertSafeBackupRoot(rootLink);
  } catch (error) {
    rootBlocked =
      error.message === 'BACKUP_ROOT_UNSAFE' || error.message === 'BACKUP_ROOT_NOT_CANONICAL';
  }
  if (!rootBlocked) throw new Error('ROOT_SYMLINK_NOT_BLOCKED');
  console.log('STEP12_BACKUP_FILESYSTEM_SAFETY=PASSED');
  console.log('STEP12_BACKUP_REFERENCE_PORTABILITY=PASSED');
  console.log('STEP12_BACKUP_ARTIFACT_PATH_SAFETY=PASSED');
} finally {
  await rm(temp, { recursive: true, force: true });
}
