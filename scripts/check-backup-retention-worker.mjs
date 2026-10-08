import { mkdtemp, mkdir, writeFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedBackupDirectory,
  purgeBackupDirectory,
  purgeBackupCopies,
} from '../tools/backup-retention-worker/filesystem.mjs';
import { checkPrerequisites } from '../tools/backup-retention-worker/config.mjs';
import { readFile } from 'node:fs/promises';

const source = {
  start: await readFile(
    new URL('../tools/backup-retention-worker/start.mjs', import.meta.url),
    'utf8',
  ),
  protocol: await readFile(
    new URL('../tools/backup-retention-worker/protocol.mjs', import.meta.url),
    'utf8',
  ),
  filesystem: await readFile(
    new URL('../tools/backup-retention-worker/filesystem.mjs', import.meta.url),
    'utf8',
  ),
};

const compact = (value) => value.replace(/\s+/g, '');
const contains = (value, marker) => compact(value).includes(compact(marker));
const position = (value, marker) => compact(value).indexOf(compact(marker));
const checks = [
  [
    'check-before-claim',
    position(source.start, 'checkPrerequisites(config)') <
      position(source.start, 'claimRetention(config)'),
  ],
  ['service-role-rpc', contains(source.protocol, 'serviceRoleKey')],
  [
    'retention-rpc',
    contains(source.protocol, 'claim_backup_retention_job') &&
      contains(source.protocol, 'finish_backup_retention_job'),
  ],
  [
    'exact-manifest-reference',
    contains(source.filesystem, "ref.hash!=='#database'") &&
      contains(source.filesystem, "ref.protocol==='plateform-backup:'") &&
      contains(source.filesystem, "ref.pathname!=='/manifest.json'"),
  ],
  ['symlink-rejected', contains(source.filesystem, 'isSymbolicLink()')],
  [
    'recursive-delete-after-validation',
    position(source.filesystem, 'expectedBackupDirectory') <
      position(source.filesystem, 'await rm(directoryReal'),
  ],
  [
    'primary-and-replica-purge',
    contains(source.start, 'purgeBackupCopies(config.backupRoot,config.replicaRoot') &&
      contains(source.filesystem, 'export async function purgeBackupCopies'),
  ],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) throw new Error(`STATIC:${failed.join(',')}`);

const root = await mkdtemp(join(tmpdir(), 'plateform-retention-'));
const replica = await mkdtemp(join(tmpdir(), 'plateform-retention-replica-'));
const outside = await mkdtemp(join(tmpdir(), 'plateform-retention-outside-'));
try {
  const id = '11111111-1111-4111-8111-111111111111';
  const dir = join(root, id);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, 'manifest.json'), '{}');
  await writeFile(join(dir, 'artifact.enc'), 'payload');
  const ref = `plateform-backup://${id}/manifest.json#database`;
  if (expectedBackupDirectory(root, id, ref) !== dir) throw new Error('EXPECTED_DIRECTORY');
  const result = await purgeBackupDirectory(root, id, ref);
  if (result.alreadyMissing) throw new Error('PURGE_REPORTED_MISSING');
  await lstat(dir).then(
    () => {
      throw new Error('DIRECTORY_RETAINED');
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );

  const missing = await purgeBackupDirectory(root, id, ref);
  if (!missing.alreadyMissing) throw new Error('MISSING_NOT_IDEMPOTENT');

  const bothId = '33333333-3333-4333-8333-333333333333';
  for (const base of [root, replica]) {
    const copy = join(base, bothId);
    await mkdir(copy, { mode: 0o700 });
    await writeFile(join(copy, 'manifest.json'), '{}');
    await writeFile(join(copy, 'artifact.enc'), 'payload');
  }
  const bothRef = `plateform-backup://${bothId}/manifest.json#database`;
  const both = await purgeBackupCopies(root, replica, bothId, bothRef);
  if (both.primary.alreadyMissing || both.replica.alreadyMissing)
    throw new Error('DUAL_PURGE_REPORTED_MISSING');
  for (const base of [root, replica]) {
    await lstat(join(base, bothId)).then(
      () => {
        throw new Error('DUAL_PURGE_RETAINED');
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }

  const outsideRef = `file://${join(outside, 'manifest.json')}#database`;
  let outsideCode = '';
  try {
    expectedBackupDirectory(root, id, outsideRef);
  } catch (error) {
    outsideCode = error.message;
  }
  if (outsideCode !== 'RETENTION_REFERENCE_OUTSIDE_ROOT')
    throw new Error(`OUTSIDE_ROOT_NOT_REJECTED:${outsideCode}`);

  const symlinkId = '22222222-2222-4222-8222-222222222222';
  const target = join(outside, 'target');
  await mkdir(target);
  await symlink(target, join(root, symlinkId), 'dir');
  const symlinkRef = `plateform-backup://${symlinkId}/manifest.json#database`;
  let symlinkCode = '';
  try {
    await purgeBackupDirectory(root, symlinkId, symlinkRef);
  } catch (error) {
    symlinkCode = error.message;
  }
  if (symlinkCode !== 'RETENTION_UNSAFE_DIRECTORY')
    throw new Error(`SYMLINK_NOT_REJECTED:${symlinkCode}`);

  await checkPrerequisites({ backupRoot: root, replicaRoot: replica, leaseSeconds: 300 });
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(replica, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
console.log('STEP12_RETENTION_WORKER_STATIC_GATE=PASSED');
console.log('STEP12_RETENTION_FILESYSTEM_DELETE=PASSED');
console.log('STEP12_RETENTION_OUTSIDE_ROOT_REJECTED=PASSED');
console.log('STEP12_RETENTION_SYMLINK_REJECTED=PASSED');
console.log('STEP12_RETENTION_PORTABLE_REFERENCE=PASSED');
console.log('STEP12_RETENTION_PRIMARY_REPLICA_PURGE=PASSED');
