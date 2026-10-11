import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const RECEIVER = 'https://dkbjgvovxgglqhqxmuyb.supabase.co/functions/v1/audit-archive-receiver';
const SOURCE = 'abdxvlykasqmknexxhjo';
const BUCKET = 'plateform-audit-archive-primary';
const enc = new TextEncoder();
const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, '0')).join('');
async function sha(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
async function keyFromToken(token: string): Promise<CryptoKey> {
  if (token.length < 32) throw new Error('ARCHIVE_RECOVERY_KEY_UNAVAILABLE');
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    enc.encode('plateform-audit-archive-aes-v1:' + token),
  );
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, [
    'decrypt',
  ]);
}
async function open(key: CryptoKey, cipher: Uint8Array): Promise<Uint8Array> {
  if (cipher.length < 29) throw new Error('ARCHIVE_RECOVERY_TRUNCATED');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: cipher.slice(0, 12) },
      key,
      cipher.slice(12),
    ),
  );
}
const bytesFromB64 = (v: string): Uint8Array => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data: trusted, error: trustError } = await client.rpc('verify_continuity_worker_token', {
    p_token: req.headers.get('x-plateform-worker-token') ?? '',
  });
  if (trustError || trusted !== true) return new Response('Not Found', { status: 404 });
  let countBatches = 0;
  let countRows = 0;
  let finalChain: string | null = null;
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error('ARCHIVE_VERIFY_RPC_FAILED');
    return data;
  };
  try {
    const status = await rpc('audit_archive_status');
    const lastBatch = Number(status.last_batch);
    const after = Math.max(0, lastBatch - 25);
    const items = await rpc('list_audit_archive_checkpoints', { p_after: after, p_limit: 25 });
    if (!Array.isArray(items) || items.length !== lastBatch - after)
      throw new Error('ARCHIVE_VERIFY_CHECKPOINT_GAP');
    const config = await rpc('get_continuity_replica_runtime_config');
    if (
      config?.target_url !==
        'https://dkbjgvovxgglqhqxmuyb.supabase.co/functions/v1/continuity-replica-receiver' ||
      typeof config.channel_token !== 'string' ||
      typeof config.target_anon_jwt !== 'string'
    )
      throw new Error('ARCHIVE_VERIFY_CONFIG_INVALID');
    const key = await keyFromToken(config.channel_token);
    const remote = async (body: Record<string, unknown>) => {
      const result = await fetch(RECEIVER, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + config.target_anon_jwt,
          apikey: config.target_anon_jwt,
          'x-plateform-source': SOURCE,
          'x-plateform-replica-token': config.channel_token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
      if (!result.ok) throw new Error('ARCHIVE_REPLICA_RECOVERY_UNAVAILABLE');
      return result.json();
    };
    const remoteProof = await remote({ action: 'verify', after_batch: after, limit: 25 });
    if (remoteProof.status !== 'VERIFIED' || remoteProof.checked_batches !== items.length) {
      throw new Error('ARCHIVE_REPLICA_WITNESS_INVALID');
    }
    let prev = items[0]?.previous_chain_sha256 ?? '0'.repeat(64);
    let nextSeq = after + 1;
    for (const row of items) {
      if (row.batch_no !== nextSeq || row.previous_chain_sha256 !== prev) {
        throw new Error('ARCHIVE_LOCAL_CHAIN_DISCONTINUITY');
      }
      const { data: blob, error: downloadError } = await client.storage
        .from(BUCKET)
        .download(row.object_path);
      if (downloadError || !blob) throw new Error('ARCHIVE_PRIMARY_OBJECT_MISSING');
      const cipher = new Uint8Array(await blob.arrayBuffer());
      if ((await sha(cipher)) !== row.payload_sha256)
        throw new Error('ARCHIVE_PRIMARY_DIGEST_FAILED');
      const plain = await open(key, cipher);
      if ((await sha(plain)) !== row.plaintext_sha256)
        throw new Error('ARCHIVE_PRIMARY_DECRYPT_FAILED');
      const data = JSON.parse(new TextDecoder().decode(plain));
      if (
        data.version !== 1 ||
        data.batch_no !== row.batch_no ||
        data.previous_chain !== prev ||
        !Array.isArray(data.rows) ||
        data.rows.length !== row.row_count ||
        data.rows.at(-1)?.id !== row.ending_id ||
        data.rows.at(-1)?.timestamp !== row.ending_at
      ) {
        throw new Error('ARCHIVE_RECOVERED_ROWS_INVALID');
      }
      const restored = await remote({ action: 'recover', batch_no: row.batch_no });
      if (
        restored.status !== 'RECOVERED_CIPHERTEXT' ||
        restored.sha256 !== row.payload_sha256 ||
        restored.chain_sha256 !== row.chain_sha256 ||
        typeof restored.ciphertext_b64 !== 'string'
      )
        throw new Error('ARCHIVE_REMOTE_RESTORE_FAILED');
      const replicaBytes = bytesFromB64(restored.ciphertext_b64);
      if ((await sha(replicaBytes)) !== row.payload_sha256)
        throw new Error('ARCHIVE_REPLICA_DIGEST_FAILED');
      const replicaPlain = await open(key, replicaBytes);
      if ((await sha(replicaPlain)) !== row.plaintext_sha256)
        throw new Error('ARCHIVE_REPLICA_DECRYPT_FAILED');
      const expectedChain = await sha(
        enc.encode(
          prev +
            ':' +
            row.batch_no +
            ':' +
            row.payload_sha256 +
            ':' +
            row.plaintext_sha256 +
            ':' +
            row.row_count +
            ':' +
            row.ending_id,
        ),
      );
      if (expectedChain !== row.chain_sha256) throw new Error('ARCHIVE_CHAIN_REPLAY_FAILED');
      prev = row.chain_sha256;
      nextSeq++;
      countRows += row.row_count;
      countBatches++;
    }
    finalChain = prev;
    if (prev !== remoteProof.last_chain_sha256) throw new Error('ARCHIVE_REMOTE_CHAIN_MISMATCH');
    if (lastBatch <= 25 && (prev !== status.chain_sha256 || countRows !== status.archived_rows)) {
      throw new Error('ARCHIVE_FULL_HISTORY_MISMATCH');
    }
    const recorded = await rpc('record_audit_archive_verification', {
      p_pass: true,
      p_batches: countBatches,
      p_rows: countRows,
      p_chain: finalChain,
    });
    if (recorded !== true) throw new Error('ARCHIVE_PROOF_RECORD_FAILED');
    return Response.json(
      {
        status: 'PASS',
        checked_batches: countBatches,
        recovered_rows: countRows,
        full_history_verified: lastBatch <= 25,
        last_batch: lastBatch,
        chain_sha256: finalChain,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    const code = (e instanceof Error ? e.message : 'ARCHIVE_VERIFY_UNKNOWN')
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 80);
    console.error('archive verify', code);
    await rpc('record_audit_archive_verification', {
      p_pass: false,
      p_batches: countBatches,
      p_rows: countRows,
      p_chain: finalChain,
      p_failure_code: code,
    }).catch(() => {});
    return Response.json({ status: 'FAIL', code }, { status: 500 });
  }
});
