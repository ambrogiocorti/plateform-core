import { spawn } from 'node:child_process';

export const STORAGE_METADATA_STATE_SQL = `with bucket_rows as (
  select id,jsonb_build_object(
    'id',id,'name',name,'owner',owner::text,'public',public,
    'avif_autodetection',avif_autodetection,'file_size_limit',file_size_limit,
    'allowed_mime_types',allowed_mime_types,'owner_id',owner_id,'type',type::text,
    'versioning_status',versioning_status,'lifecycle_configuration',lifecycle_configuration,
    'lifecycle_configuration_generation',lifecycle_configuration_generation::text
  )::text payload
  from storage.buckets
), object_rows as (
  select bucket_id,name,id,jsonb_build_object(
    'id',id::text,'bucket_id',bucket_id,'name',name,'owner',owner::text,
    'metadata',metadata,'path_tokens',path_tokens,'owner_id',owner_id,
    'user_metadata',user_metadata,'archived_at',archived_at,
    'is_delete_marker',is_delete_marker,'is_versioned',is_versioned
  )::text payload
  from storage.objects
), combined as (
  select coalesce((select string_agg('B|'||payload,E'\\n' order by id) from bucket_rows),'')
    || E'\\n--OBJECTS--\\n' ||
    coalesce((select string_agg('O|'||payload,E'\\n' order by bucket_id,name,id) from object_rows),'') body
)
select json_build_object(
  'bucket_count',(select count(*) from storage.buckets),
  'object_count',(select count(*) from storage.objects),
  'unsupported_bucket_count',(select count(*) from storage.buckets where type::text<>'STANDARD' or coalesce(versioning_status,'DISABLED')<>'DISABLED'),
  'aggregate_sha256',encode(digest((select body from combined),'sha256'),'hex')
);`;

async function capture(command, args, secrets = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      let safe = stderr;
      for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[REDACTED]');
      reject(new Error(`STORAGE_METADATA_QUERY_FAILED:${code}:${safe.slice(0, 400)}`));
    });
  });
}

export async function storageMetadataState(psql, databaseUrl) {
  const output = await capture(
    psql,
    [
      '-X',
      '-A',
      '-t',
      '--set',
      'ON_ERROR_STOP=1',
      '--dbname',
      databaseUrl,
      '--command',
      STORAGE_METADATA_STATE_SQL,
    ],
    [databaseUrl],
  );
  let row;
  try {
    row = JSON.parse(output.trim());
  } catch {
    throw new Error('STORAGE_METADATA_STATE_INVALID');
  }
  const result = {
    bucketCount: Number(row.bucket_count),
    objectCount: Number(row.object_count),
    unsupportedBucketCount: Number(row.unsupported_bucket_count),
    aggregateSha256: String(row.aggregate_sha256 ?? ''),
  };
  if (
    !Number.isInteger(result.bucketCount) ||
    result.bucketCount < 0 ||
    !Number.isInteger(result.objectCount) ||
    result.objectCount < 0 ||
    !Number.isInteger(result.unsupportedBucketCount) ||
    result.unsupportedBucketCount < 0 ||
    !/^[0-9a-f]{64}$/.test(result.aggregateSha256)
  )
    throw new Error('STORAGE_METADATA_STATE_INVALID');
  return result;
}

export function assertStorageBackupSnapshot(before, after, exported) {
  if (before?.unsupportedBucketCount !== 0 || after?.unsupportedBucketCount !== 0)
    throw new Error('STORAGE_BUCKET_MODE_UNSUPPORTED');
  if (
    before.bucketCount !== after.bucketCount ||
    before.objectCount !== after.objectCount ||
    before.aggregateSha256 !== after.aggregateSha256
  )
    throw new Error('STORAGE_SNAPSHOT_CHANGED_DURING_BACKUP');
  if (
    !exported ||
    after.bucketCount !== exported.buckets?.length ||
    after.objectCount !== exported.objects?.length
  )
    throw new Error('STORAGE_SNAPSHOT_COUNT_MISMATCH');
  return after;
}

export async function verifyStorageMetadata(psql, databaseUrl, expected) {
  if (
    !expected ||
    !Number.isInteger(expected.bucket_count) ||
    expected.bucket_count < 0 ||
    !Number.isInteger(expected.object_count) ||
    expected.object_count < 0 ||
    !/^[0-9a-f]{64}$/.test(String(expected.aggregate_sha256 ?? ''))
  )
    throw new Error('RESTORE_STORAGE_METADATA_MANIFEST_INVALID');
  const actual = await storageMetadataState(psql, databaseUrl);
  return {
    storage_metadata:
      actual.bucketCount === expected.bucket_count &&
      actual.objectCount === expected.object_count &&
      actual.aggregateSha256 === expected.aggregate_sha256,
    storage_bucket_count: actual.bucketCount,
    storage_object_count: actual.objectCount,
    storage_metadata_hash: actual.aggregateSha256,
  };
}
