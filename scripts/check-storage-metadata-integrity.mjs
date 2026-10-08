import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStorageBackupSnapshot,
  storageMetadataState,
  verifyStorageMetadata,
} from '../tools/backup-worker/storage-metadata.mjs';

const temp = await mkdtemp(join(tmpdir(), 'plateform-storage-meta-'));
const fake = join(temp, 'psql');
const hash = 'cd'.repeat(32);
try {
  await writeFile(
    fake,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({bucket_count:4,object_count:3,unsupported_bucket_count:0,aggregate_sha256:'${hash}'})+'\\n');\n`,
    { mode: 0o700 },
  );
  await chmod(fake, 0o700);
  const state = await storageMetadataState(
    fake,
    'postgresql://postgres.test:pw@localhost/postgres',
  );
  if (
    state.bucketCount !== 4 ||
    state.objectCount !== 3 ||
    state.unsupportedBucketCount !== 0 ||
    state.aggregateSha256 !== hash
  )
    throw new Error('STORAGE_META_STATE');
  const ok = await verifyStorageMetadata(fake, 'postgresql://postgres.test:pw@localhost/postgres', {
    bucket_count: 4,
    object_count: 3,
    aggregate_sha256: hash,
  });
  if (
    ok.storage_metadata !== true ||
    ok.storage_bucket_count !== 4 ||
    ok.storage_object_count !== 3 ||
    ok.storage_metadata_hash !== hash
  )
    throw new Error('STORAGE_META_VERIFY');
  const mismatch = await verifyStorageMetadata(
    fake,
    'postgresql://postgres.test:pw@localhost/postgres',
    { bucket_count: 4, object_count: 2, aggregate_sha256: hash },
  );
  if (mismatch.storage_metadata !== false) throw new Error('STORAGE_META_MISMATCH_NOT_DETECTED');
  const base = { bucketCount: 4, objectCount: 3, unsupportedBucketCount: 0, aggregateSha256: hash };
  assertStorageBackupSnapshot(
    base,
    { ...base },
    { buckets: Array(4).fill({}), objects: Array(3).fill({}) },
  );
  let changed = false,
    countMismatch = false,
    unsupported = false;
  try {
    assertStorageBackupSnapshot(
      base,
      { ...base, aggregateSha256: 'ef'.repeat(32) },
      { buckets: Array(4).fill({}), objects: Array(3).fill({}) },
    );
  } catch (error) {
    changed = error?.message === 'STORAGE_SNAPSHOT_CHANGED_DURING_BACKUP';
  }
  try {
    assertStorageBackupSnapshot(
      base,
      { ...base },
      { buckets: Array(4).fill({}), objects: Array(2).fill({}) },
    );
  } catch (error) {
    countMismatch = error?.message === 'STORAGE_SNAPSHOT_COUNT_MISMATCH';
  }
  try {
    assertStorageBackupSnapshot(
      { ...base, unsupportedBucketCount: 1 },
      { ...base },
      { buckets: Array(4).fill({}), objects: Array(3).fill({}) },
    );
  } catch (error) {
    unsupported = error?.message === 'STORAGE_BUCKET_MODE_UNSUPPORTED';
  }
  if (!changed || !countMismatch || !unsupported)
    throw new Error('STORAGE_BACKUP_SNAPSHOT_FAIL_CLOSED');
  console.log('STEP12_STORAGE_METADATA_STATE=PASSED');
  console.log('STEP12_STORAGE_METADATA_VERIFY=PASSED');
  console.log('STEP12_STORAGE_METADATA_MISMATCH_FAIL_CLOSED=PASSED');
  console.log('STEP12_STORAGE_BACKUP_SNAPSHOT_FAIL_CLOSED=PASSED');
} finally {
  await rm(temp, { recursive: true, force: true });
}
