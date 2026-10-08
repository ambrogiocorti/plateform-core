import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBackupRoots,
  replicateBackupDirectory,
  removeReplicaDirectory,
} from '../tools/backup-worker/replica.mjs';

const base = await mkdtemp(join(tmpdir(), 'plateform-replica-'));
try {
  const primary = join(base, 'primary');
  const replica = join(base, 'replica');
  await mkdir(primary, { mode: 0o700 });
  await mkdir(replica, { mode: 0o700 });

  let sameDevice = '';
  try {
    await checkBackupRoots(primary, replica, false);
  } catch (error) {
    sameDevice = error.message;
  }
  if (sameDevice !== 'BACKUP_REPLICA_SAME_DEVICE')
    throw new Error(`SAME_DEVICE_NOT_REJECTED:${sameDevice}`);
  const roots = await checkBackupRoots(primary, replica, true);
  if (!roots.sameDevice) throw new Error('EXPECTED_TEST_ROOTS_SAME_DEVICE');

  const id = '11111111-1111-4111-8111-111111111111';
  const source = join(primary, id);
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'manifest.json'), 'manifest-v1', { mode: 0o600 });
  await writeFile(join(source, 'data.sql.enc'), 'encrypted-v1', { mode: 0o600 });

  const first = await replicateBackupDirectory(source, replica, id);
  if (
    first.fileCount !== 2 ||
    first.sizeBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(first.aggregateSha256)
  )
    throw new Error('REPLICA_PROOF_INVALID');
  if ((await readFile(join(replica, id, 'data.sql.enc'), 'utf8')) !== 'encrypted-v1')
    throw new Error('REPLICA_CONTENT_MISMATCH');

  const identical = await replicateBackupDirectory(source, replica, id);
  if (
    identical.aggregateSha256 !== first.aggregateSha256 ||
    identical.fileCount !== first.fileCount
  )
    throw new Error('REPLICA_IDEMPOTENT_PROOF_MISMATCH');

  await writeFile(join(source, 'data.sql.enc'), 'encrypted-v2', { mode: 0o600 });
  let conflict = '';
  try {
    await replicateBackupDirectory(source, replica, id);
  } catch (error) {
    conflict = error.message;
  }
  if (conflict !== 'BACKUP_REPLICA_IMMUTABLE_CONFLICT')
    throw new Error(`REPLICA_CONFLICT_NOT_REJECTED:${conflict}`);
  if ((await readFile(join(replica, id, 'data.sql.enc'), 'utf8')) !== 'encrypted-v1')
    throw new Error('REPLICA_EXISTING_COPY_WAS_MUTATED');

  const nested = join(primary, 'nested');
  await mkdir(nested, { mode: 0o700 });
  let nestedCode = '';
  try {
    await checkBackupRoots(primary, nested, true);
  } catch (error) {
    nestedCode = error.message;
  }
  if (nestedCode !== 'BACKUP_REPLICA_ROOT_NOT_INDEPENDENT')
    throw new Error(`NESTED_ROOT_NOT_REJECTED:${nestedCode}`);

  const target = join(base, 'symlink-target');
  await mkdir(target, { mode: 0o700 });
  const link = join(base, 'replica-link');
  await symlink(target, link, 'dir');
  let linkCode = '';
  try {
    await checkBackupRoots(primary, link, true);
  } catch (error) {
    linkCode = error.message;
  }
  if (!['BACKUP_ROOT_UNSAFE', 'BACKUP_ROOT_NOT_CANONICAL'].includes(linkCode))
    throw new Error(`SYMLINK_ROOT_NOT_REJECTED:${linkCode}`);

  await removeReplicaDirectory(replica, id);
  await lstat(join(replica, id)).then(
    () => {
      throw new Error('REPLICA_REMOVE_FAILED');
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  await removeReplicaDirectory(replica, id);
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log('STEP12_BACKUP_REPLICA_SAME_DEVICE_GUARD=PASSED');
console.log('STEP12_BACKUP_REPLICA_ATOMIC_COPY=PASSED');
console.log('STEP12_BACKUP_REPLICA_IDEMPOTENT_WRITE_ONCE=PASSED');
console.log('STEP12_BACKUP_REPLICA_IMMUTABLE_CONFLICT=PASSED');
console.log('STEP12_BACKUP_REPLICA_HASH_PROOF=PASSED');
console.log('STEP12_BACKUP_REPLICA_ROOT_SAFETY=PASSED');
console.log('STEP12_BACKUP_REPLICA_IDEMPOTENT_REMOVE=PASSED');
