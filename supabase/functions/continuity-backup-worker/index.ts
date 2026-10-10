import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const PRIMARY_BUCKET = 'plateform-continuity-primary';
const SOURCE_REF = (() => {
  const configured = Deno.env.get('SUPABASE_URL') ?? '';
  const url = new URL(configured);
  const match = /^([a-z0-9]{20})\\.supabase\\.co$/.exec(url.hostname);
  if (url.protocol !== 'https:' || !match) {
    throw new Error('CONTINUITY_SOURCE_PROJECT_INVALID');
  }
  return match[1];
})();

function b64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response, fallbackMs: number): number {
  const value = res.headers.get('retry-after');
  if (!value) return fallbackMs;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, Math.ceil(seconds * 1000));
  }

  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    return Math.max(1000, at - Date.now());
  }

  return fallbackMs;
}

async function postReplica(cfg: any, token: string, body: Record<string, unknown>) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(String(cfg.target_url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${String(cfg.target_anon_jwt)}`,
          apikey: String(cfg.target_anon_jwt),
          'x-plateform-source': SOURCE_REF,
          'x-plateform-replica-token': token,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxAttempts) {
          throw new Error(
            res.status === 429 ? 'REPLICA_RATE_LIMIT_EXHAUSTED' : 'REPLICA_HTTP_RETRY_EXHAUSTED',
          );
        }

        const delay = retryAfterMs(res, Math.min(30000, 1000 * 2 ** (attempt - 1)));
        console.warn('replica request retry', {
          action: String(body.action ?? ''),
          attempt,
          status: res.status,
          delay_ms: delay,
        });
        await sleep(delay);
        continue;
      }

      if (!res.ok) throw new Error('REPLICA_HTTP_FAILED');

      const data = await res.json();
      if (!data || data.status === 'FAILED') {
        throw new Error('REPLICA_FAILED');
      }
      return data;
    } catch (error) {
      const retryMs = Number((error as { retryAfterMs?: number })?.retryAfterMs);
      const isRateLimit =
        (error as { name?: string })?.name === 'RateLimitError' || Number.isFinite(retryMs);

      if (!isRateLimit || attempt === maxAttempts) throw error;

      const delay = Math.max(
        1000,
        Math.min(60000, Number.isFinite(retryMs) ? retryMs : 1000 * 2 ** (attempt - 1)),
      );
      console.warn('replica transport rate-limit retry', {
        action: String(body.action ?? ''),
        attempt,
        delay_ms: delay,
      });
      await sleep(delay);
    }
  }

  throw new Error('REPLICA_RETRY_EXHAUSTED');
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const workerToken = req.headers.get('x-plateform-worker-token') ?? '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: allowed, error: verifyError } = await supabase.rpc(
    'verify_continuity_worker_token',
    { p_token: workerToken },
  );
  if (verifyError || allowed !== true) return new Response('Not Found', { status: 404 });

  // No unnecessary network probes when there is no runnable work. This also
  // preserves the scheduled-backup pause while permitting future manual jobs.
  const leaseCutoff = new Date().toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from('backup_metadata')
    .select('id')
    .or(`status.eq.QUEUED,and(status.eq.RUNNING,lease_expires_at.lt.${leaseCutoff})`)
    .limit(1);
  if (pendingError) {
    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'ERROR',
      p_details: { phase: 'queue_precheck', code: 'BACKUP_QUEUE_CHECK_FAILED' },
    });
    return Response.json({ status: 'BLOCKED', code: 'BACKUP_QUEUE_CHECK_FAILED' }, { status: 503 });
  }
  if (!pending?.length) {
    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'IDLE',
      p_details: { phase: 'idle', reason: 'NO_JOB' },
    });
    return Response.json({ status: 'IDLE' });
  }

  // Verify the authenticated replica BEFORE claiming a backup or allocating a snapshot.
  let replicaConfig: any;
  try {
    const { data: candidate, error: configError } = await supabase.rpc(
      'get_continuity_replica_runtime_config',
    );
    if (
      configError ||
      !candidate?.target_url ||
      !candidate?.target_anon_jwt ||
      !candidate?.channel_token
    ) {
      throw new Error('REPLICA_CONFIG_UNAVAILABLE');
    }
    const endpoint = new URL(String(candidate.target_url));
    const hostParts = endpoint.hostname.split('.');
    if (
      endpoint.protocol !== 'https:' ||
      hostParts.length !== 3 ||
      !/^[a-z0-9]{20}$/.test(hostParts[0] ?? '') ||
      hostParts[1] !== 'supabase' ||
      hostParts[2] !== 'co' ||
      hostParts[0] === SOURCE_REF ||
      endpoint.pathname !== '/functions/v1/continuity-replica-receiver' ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error('REPLICA_ENDPOINT_INVALID');
    }
    const ready = await postReplica(candidate, String(candidate.channel_token), {
      action: 'preflight',
    });
    if (ready?.status !== 'READY' || ready?.project_ref !== hostParts[0]) {
      throw new Error('REPLICA_NOT_READY');
    }
    replicaConfig = candidate;
  } catch (error) {
    console.error('replica preflight blocked backup before snapshot', {
      message: error instanceof Error ? error.message : 'UNKNOWN',
    });
    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'ERROR',
      p_details: { phase: 'replica_preflight', code: 'REPLICA_PREFLIGHT_BLOCKED' },
    });
    return Response.json({ status: 'BLOCKED', code: 'REPLICA_PREFLIGHT_BLOCKED' }, { status: 503 });
  }

  let job: any = null;

  try {
    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'WORKING',
      p_details: { phase: 'claim' },
    });

    const { data: claimed, error: claimError } = await supabase.rpc('claim_backup_job', {
      p_lease_seconds: 1800,
    });
    if (claimError) throw new Error('CLAIM_FAILED');

    job = claimed;
    if (!job?.id) {
      await supabase.rpc('record_continuity_worker_heartbeat', {
        p_worker: 'BACKUP',
        p_status: 'IDLE',
        p_details: { phase: 'idle', reason: 'NO_JOB' },
      });
      return Response.json({ status: 'IDLE' });
    }

    const backupId = String(job.id);
    const lease = String(job.lease_token);

    const { data: prepared, error: prepareError } = await supabase.rpc(
      'prepare_continuity_backup_snapshot',
      { p_backup: backupId, p_lease: lease, p_chunk_size: 200 },
    );
    if (prepareError || !prepared?.final) throw new Error('SNAPSHOT_FAILED');

    const cfg = replicaConfig;
    const replicaProjectRef = new URL(String(cfg.target_url)).hostname.split('.')[0] ?? '';
    const primaryRef = `supabase-storage://${SOURCE_REF}/${PRIMARY_BUCKET}/${backupId}`;
    const replicaRef = `supabase-storage://${replicaProjectRef}/plateform-continuity-replica/${backupId}`;

    const { data: meta, error: metaError } = await supabase.rpc(
      'build_continuity_backup_artifact_meta_v2',
      {
        p_backup: backupId,
        p_lease: lease,
        p_primary_reference: primaryRef,
        p_replica_reference: replicaRef,
      },
    );
    if (metaError || !meta?.manifest || !meta?.key_envelope_b64) {
      console.error('artifact meta failed', metaError);
      throw new Error('MANIFEST_FAILED');
    }

    const { data: migrationBundle, error: migrationError } = await supabase.rpc(
      'export_continuity_migration_bundle',
      { p_backup: backupId, p_lease: lease },
    );
    if (migrationError || !migrationBundle?.items) {
      console.error('migration bundle failed', migrationError);
      throw new Error('MIGRATION_BUNDLE_FAILED');
    }
    const migrationHash = String(migrationBundle.aggregate_sha256 ?? '');
    if (!/^[0-9a-f]{64}$/.test(migrationHash)) {
      throw new Error('MIGRATION_HASH_INVALID');
    }

    const { error: bucketError } = await supabase.storage.createBucket(PRIMARY_BUCKET, {
      public: false,
      fileSizeLimit: 8 * 1024 * 1024,
    });
    if (bucketError && !String(bucketError.message).toLowerCase().includes('already exists')) {
      throw new Error('PRIMARY_BUCKET_FAILED');
    }

    const manifestBytes = new TextEncoder().encode(JSON.stringify(meta.manifest));
    const hmacBytes = new TextEncoder().encode(String(meta.manifest_hmac) + '\n');
    const envelopeBytes = b64ToBytes(String(meta.key_envelope_b64));
    const migrationBytes = new TextEncoder().encode(JSON.stringify(migrationBundle));
    const migrationHashBytes = new TextEncoder().encode(migrationHash + '\n');

    const primaryFiles: Array<[string, Uint8Array, string]> = [
      ['manifest.json', manifestBytes, 'application/json'],
      ['manifest.hmac', hmacBytes, 'text/plain'],
      ['key-envelope.bin', envelopeBytes, 'application/octet-stream'],
      ['migrations.json', migrationBytes, 'application/json'],
      ['migration-history.sha256', migrationHashBytes, 'text/plain'],
    ];

    const hashes = new Map<string, string>();
    let totalBytes = 0;

    for (const [name, bytes, contentType] of primaryFiles) {
      const { error } = await supabase.storage
        .from(PRIMARY_BUCKET)
        .upload(`${backupId}/${name}`, bytes, {
          upsert: true,
          contentType,
          cacheControl: '0',
        });
      if (error) throw new Error('PRIMARY_UPLOAD_FAILED');
      hashes.set(name, await sha256Hex(bytes));
      totalBytes += bytes.byteLength;
    }

    const replicaInit = await postReplica(cfg, String(cfg.channel_token), {
      action: 'init',
      backup_id: backupId,
      manifest: meta.manifest,
      manifest_hmac: meta.manifest_hmac,
      key_envelope_b64: meta.key_envelope_b64,
      migration_bundle: migrationBundle,
      migration_hash: migrationHash,
    });
    if (replicaInit.key_escrow !== true || replicaInit.migration_bundle !== true) {
      throw new Error('REPLICA_INIT_VERIFICATION_FAILED');
    }

    const chunkCount = Number(meta.chunk_count ?? 0);
    if (!Number.isInteger(chunkCount) || chunkCount < 1) {
      throw new Error('EMPTY_BACKUP');
    }

    for (let chunkNo = 0; chunkNo < chunkCount; chunkNo++) {
      const { data: chunk, error: chunkError } = await supabase.rpc(
        'export_continuity_backup_chunk',
        { p_backup: backupId, p_lease: lease, p_chunk_no: chunkNo },
      );
      if (chunkError || !chunk?.cipher_b64) throw new Error('CHUNK_EXPORT_FAILED');

      const bytes = b64ToBytes(String(chunk.cipher_b64));
      const name = `chunk-${String(chunkNo).padStart(6, '0')}.bin`;
      const localHash = await sha256Hex(bytes);

      const { error: uploadError } = await supabase.storage
        .from(PRIMARY_BUCKET)
        .upload(`${backupId}/${name}`, bytes, {
          upsert: true,
          contentType: 'application/octet-stream',
          cacheControl: '0',
        });
      if (uploadError) throw new Error('PRIMARY_CHUNK_UPLOAD_FAILED');

      const replicaChunk = await postReplica(cfg, String(cfg.channel_token), {
        action: 'chunk',
        backup_id: backupId,
        chunk_no: chunkNo,
        cipher_b64: chunk.cipher_b64,
      });
      if (String(replicaChunk.cipher_sha256 ?? '') !== localHash) {
        throw new Error('REPLICA_CHUNK_HASH_MISMATCH');
      }

      hashes.set(name, localHash);
      totalBytes += bytes.byteLength;
    }

    const aggregateMaterial = [...hashes.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, hash]) => `${name}:${hash}`)
      .join('|');
    const primaryAggregate = await sha256Hex(new TextEncoder().encode(aggregateMaterial));

    const replicaSummary = await postReplica(cfg, String(cfg.channel_token), {
      action: 'finalize',
      backup_id: backupId,
    });

    if (
      Number(replicaSummary.file_count) !== hashes.size ||
      Number(replicaSummary.total_bytes) !== totalBytes ||
      String(replicaSummary.aggregate_hash) !== primaryAggregate
    ) {
      throw new Error('REPLICA_FINAL_MISMATCH');
    }

    const verification = {
      database: true,
      migrations: true,
      auth: true,
      storage: true,
      storage_metadata: true,
      manifest: true,
      manifest_auth: true,
      private_state: true,
      replica: true,
      replica_file_count: Number(replicaSummary.file_count),
      replica_size_bytes: Number(replicaSummary.total_bytes),
      replica_hash: String(replicaSummary.aggregate_hash),
      key_escrow: true,
      migration_bundle: true,
    };

    const { error: finishError } = await supabase.rpc('finish_backup_job', {
      p_id: backupId,
      p_lease: lease,
      p_success: true,
      p_database_reference: primaryRef + '#database',
      p_auth_reference: primaryRef + '#auth',
      p_storage_reference: primaryRef + '#storage',
      p_manifest: meta.manifest,
      p_verification: verification,
      p_checksum: primaryAggregate,
      p_size_bytes: totalBytes,
      p_object_count: Number(meta.row_count ?? 0),
      p_encryption_key_id: `backup:${backupId}`,
      p_error_code: null,
    });
    if (finishError) {
      console.error('finish backup rejected', {
        code: finishError.code,
        message: finishError.message,
        details: finishError.details,
        hint: finishError.hint,
      });
      throw new Error(
        'FINISH_BACKUP_' + String(finishError.message ?? finishError.code ?? 'FAILED'),
      );
    }

    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'IDLE',
      p_details: {
        phase: 'complete',
        backup_id: backupId,
        files: hashes.size,
        bytes: totalBytes,
      },
    });

    return Response.json({
      status: 'SUCCEEDED',
      backup_id: backupId,
      file_count: hashes.size,
      total_bytes: totalBytes,
      aggregate_hash: primaryAggregate,
    });
  } catch (error) {
    console.error('backup worker failed', error);

    if (job?.id && job?.lease_token) {
      await supabase.rpc('finish_backup_job', {
        p_id: String(job.id),
        p_lease: String(job.lease_token),
        p_success: false,
        p_database_reference: null,
        p_auth_reference: null,
        p_storage_reference: null,
        p_manifest: null,
        p_verification: null,
        p_checksum: null,
        p_size_bytes: null,
        p_object_count: null,
        p_encryption_key_id: null,
        p_error_code: 'BACKUP_WORKER_FAILED',
      });
    }

    await supabase.rpc('record_continuity_worker_heartbeat', {
      p_worker: 'BACKUP',
      p_status: 'ERROR',
      p_details: { phase: 'failed', code: 'BACKUP_WORKER_FAILED' },
    });

    return Response.json({ status: 'FAILED' }, { status: 500 });
  }
});
