import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function safePart(value) {
  if (!value || value.includes('..') || value.startsWith('/') || value.includes('\\'))
    throw new Error('STORAGE_PATH_INVALID');
  return value;
}

async function list(client, bucket, prefix = '') {
  const output = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`STORAGE_LIST_FAILED:${bucket}`);
    const rows = data ?? [];
    for (const item of rows) {
      safePart(item.name);
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) output.push({ name, metadata: item.metadata ?? {} });
      else output.push(...(await list(client, bucket, name)));
    }
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return output;
}

export async function exportStorage(config, directory, createClient) {
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: buckets, error } = await client.storage.listBuckets();
  if (error) throw new Error('STORAGE_BUCKET_LIST_FAILED');
  const bucketManifest = [];
  const objects = [];
  for (const bucket of buckets ?? []) {
    bucketManifest.push({
      id: bucket.id,
      name: bucket.name,
      public: Boolean(bucket.public),
      file_size_limit: bucket.file_size_limit ?? null,
      allowed_mime_types: bucket.allowed_mime_types ?? null,
    });
    const rows = await list(client, bucket.id);
    for (const row of rows) {
      const { data, error: downloadError } = await client.storage
        .from(bucket.id)
        .download(row.name);
      if (downloadError || !data) throw new Error(`STORAGE_DOWNLOAD_FAILED:${bucket.id}`);
      const target = join(
        directory,
        'storage',
        safePart(bucket.id),
        ...row.name.split('/').map(safePart),
      );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(await data.arrayBuffer());
      await writeFile(target, bytes, { mode: 0o600 });
      objects.push({
        bucket: bucket.id,
        name: row.name,
        path: target,
        sizeBytes: bytes.length,
        metadata: row.metadata,
      });
    }
  }
  return { buckets: bucketManifest, objects };
}
