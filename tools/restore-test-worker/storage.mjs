import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveBackupArtifact } from '../backup-worker/filesystem.mjs';
import { decryptVerified } from '../backup-worker/crypto.mjs';

function safePathParts(value, code) {
  const raw = String(value ?? '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/'))
    throw new Error(code);
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(code);
  return parts;
}

async function bucketHasObjects(client, bucket, prefix = '') {
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`RESTORE_TARGET_STORAGE_LIST_FAILED:${bucket}`);
    const rows = data ?? [];
    for (const row of rows) {
      if (row.id) return true;
      const child = prefix ? `${prefix}/${row.name}` : row.name;
      if (await bucketHasObjects(client, bucket, child)) return true;
    }
    if (rows.length < 1000) return false;
    offset += rows.length;
  }
}

export async function targetStorageEmpty(config, createClient) {
  const target = createClient(config.targetUrl, config.targetServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: existing, error } = await target.storage.listBuckets();
  if (error) throw new Error('RESTORE_TARGET_STORAGE_UNAVAILABLE');
  for (const bucket of existing ?? []) if (await bucketHasObjects(target, bucket.id)) return false;
  return true;
}

export async function restoreStorage(
  config,
  manifest,
  backupDir,
  tempDir,
  createClient,
  encryptionKey,
) {
  const target = createClient(config.targetUrl, config.targetServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = manifest.components?.storage;
  if (!storage || !Array.isArray(storage.buckets) || !Array.isArray(storage.objects))
    throw new Error('RESTORE_STORAGE_MANIFEST_INVALID');
  const { data: existing, error: listError } = await target.storage.listBuckets();
  if (listError) throw new Error('RESTORE_TARGET_STORAGE_UNAVAILABLE');
  // data.sql restores storage.buckets/storage.objects metadata first. The object
  // payloads themselves are not in Postgres, so the byte restore must upsert
  // those expected paths instead of treating restored metadata as target data.
  const existingIds = new Set((existing ?? []).map((b) => b.id));
  for (const bucket of storage.buckets) {
    const options = {
      public: Boolean(bucket.public),
      fileSizeLimit: bucket.file_size_limit ?? undefined,
      allowedMimeTypes: bucket.allowed_mime_types ?? undefined,
    };
    if (existingIds.has(bucket.id)) {
      const { error } = await target.storage.updateBucket(bucket.id, options);
      if (error) throw new Error(`RESTORE_BUCKET_CONFIG_FAILED:${bucket.id}`);
    } else {
      const { error } = await target.storage.createBucket(bucket.id, options);
      if (error) throw new Error(`RESTORE_BUCKET_CREATE_FAILED:${bucket.id}`);
    }
  }
  let restored = 0;
  for (const object of storage.objects) {
    if (!object.file || !object.bucket || !object.name || !object.plaintext_sha256)
      throw new Error('RESTORE_STORAGE_MANIFEST_INVALID');
    const bucketParts = safePathParts(object.bucket, 'RESTORE_STORAGE_BUCKET_PATH_INVALID');
    const nameParts = safePathParts(object.name, 'RESTORE_STORAGE_OBJECT_PATH_INVALID');
    const source = await resolveBackupArtifact(backupDir, object.file);
    const targetPath = join(tempDir, 'storage', ...bucketParts, ...nameParts);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const decrypted = await decryptVerified(source, targetPath, encryptionKey, object);
    const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(decrypted.path));
    const contentType =
      object.metadata?.mimetype || object.metadata?.contentType || 'application/octet-stream';
    const cacheControl =
      object.metadata?.cacheControl || object.metadata?.cache_control || undefined;
    const { error } = await target.storage
      .from(object.bucket)
      .upload(object.name, bytes, { contentType, cacheControl, upsert: true });
    if (error) throw new Error(`RESTORE_STORAGE_UPLOAD_FAILED:${object.bucket}`);
    restored++;
  }
  return restored === storage.objects.length;
}

export async function verifyStorage(config, manifest, createClient) {
  const target = createClient(config.targetUrl, config.targetServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = manifest.components?.storage;
  if (!storage || !Array.isArray(storage.buckets) || !Array.isArray(storage.objects))
    throw new Error('RESTORE_STORAGE_MANIFEST_INVALID');
  const { data: buckets, error } = await target.storage.listBuckets();
  if (error) throw new Error('RESTORE_TARGET_STORAGE_UNAVAILABLE');
  const byId = new Map((buckets ?? []).map((bucket) => [bucket.id, bucket]));
  for (const expected of storage.buckets) {
    const actual = byId.get(expected.id);
    if (!actual || Boolean(actual.public) !== Boolean(expected.public)) return false;
  }
  for (const object of storage.objects) {
    const { data, error: downloadError } = await target.storage
      .from(object.bucket)
      .download(object.name);
    if (downloadError || !data) return false;
    const bytes = Buffer.from(await data.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== object.plaintext_sha256) return false;
  }
  return true;
}
