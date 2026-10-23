// Supabase-bound helpers shared by `audit-archive-worker` and `audit-archive-verify`.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.116.0';
import { ArchiveFailure, type ArchiveStore } from './archive.ts';

const BUCKET = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const DEFAULT_PRIMARY_BUCKET = 'plateform-continuity-audit-archive';
export const DEFAULT_REPLICA_BUCKET = 'plateform-continuity-audit-archive-replica';

/**
 * The database sends `x-plateform-worker-token: private.continuity_worker_runtime_config.worker_token`.
 * It is checked by `verify_continuity_worker_token` (service_role only), which compares SHA-256
 * digests, so the token is never compared character by character nor stored in this function.
 */
export async function authorizeWorker(request: Request, server: SupabaseClient): Promise<void> {
  const token = request.headers.get('x-plateform-worker-token');
  if (!token || token.length < 64 || token.length > 256 || /[^\x21-\x7e]/.test(token))
    throw new Error('UNAUTHORIZED');
  const { data, error } = await server.rpc('verify_continuity_worker_token', { p_token: token });
  if (error) throw new Error('REQUEST_FAILED');
  if (data !== true) throw new Error('UNAUTHORIZED');
}

function bucketName(value: string | undefined, fallback: string): string {
  const name = value?.trim() || fallback;
  if (!BUCKET.test(name)) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  return name;
}

function replicaClient(): SupabaseClient | null {
  const url = Deno.env.get('AUDIT_ARCHIVE_REPLICA_SUPABASE_URL'),
    key = Deno.env.get('AUDIT_ARCHIVE_REPLICA_SERVICE_ROLE_KEY');
  if (!url && !key) return null;
  if (!url || !key || !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/.test(url))
    throw new Error('SERVER_CONFIGURATION_REQUIRED');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, options) =>
        fetch(input, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        }),
    },
  });
}

/** Private bucket, created on first use; a public bucket is refused (fail closed). */
async function ensurePrivateBucket(client: SupabaseClient, bucket: string): Promise<void> {
  let found = await client.storage.getBucket(bucket);
  if (found.error) {
    await client.storage.createBucket(bucket, {
      public: false,
      allowedMimeTypes: ['application/octet-stream'],
    });
    found = await client.storage.getBucket(bucket);
  }
  if (found.error || !found.data) throw new Error('ARCHIVE_STORAGE_UNAVAILABLE');
  if (found.data.public) throw new Error('ARCHIVE_BUCKET_PUBLIC');
}

function store(
  name: ArchiveStore['name'],
  client: SupabaseClient,
  bucket: string,
  ensure: boolean,
): ArchiveStore {
  let ready: Promise<void> | null = null;
  return {
    name,
    async upload(path, bytes) {
      if (ensure) await (ready ??= ensurePrivateBucket(client, bucket));
      // Only the not-yet-sealed path is ever written (batch_no = last_batch + 1), so replacing an
      // object left by an attempt whose lease was released never touches a sealed checkpoint.
      const { error } = await client.storage
        .from(bucket)
        .upload(path, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), {
          contentType: 'application/octet-stream',
          upsert: true,
        });
      if (error) throw new Error('ARCHIVE_UPLOAD_FAILED');
    },
    async download(path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error) {
        const status = Number(
          (error as { status?: unknown; statusCode?: unknown }).status ??
            (error as { statusCode?: unknown }).statusCode,
        );
        if (status === 404 || status === 400 || /not.?found/i.test(error.message)) return null;
        throw new ArchiveFailure(`ARCHIVE_${name}_UNAVAILABLE`);
      }
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}

/**
 * Primary and replica stores. The replica is a second private bucket, in another Supabase project
 * when AUDIT_ARCHIVE_REPLICA_SUPABASE_URL / AUDIT_ARCHIVE_REPLICA_SERVICE_ROLE_KEY are set.
 */
export function archiveStores(server: SupabaseClient, createBuckets: boolean): ArchiveStore[] {
  const primary = bucketName(Deno.env.get('AUDIT_ARCHIVE_PRIMARY_BUCKET'), DEFAULT_PRIMARY_BUCKET),
    replica = bucketName(Deno.env.get('AUDIT_ARCHIVE_REPLICA_BUCKET'), DEFAULT_REPLICA_BUCKET),
    remote = replicaClient();
  if (!remote && primary === replica) throw new Error('SERVER_CONFIGURATION_REQUIRED');
  return [
    store('PRIMARY', server, primary, createBuckets),
    store('REPLICA', remote ?? server, replica, createBuckets),
  ];
}

export async function rpc(server: SupabaseClient, name: string, args?: object): Promise<unknown> {
  const { data, error } = await server.rpc(name, args);
  if (error) throw new Error('REQUEST_FAILED');
  return data;
}
