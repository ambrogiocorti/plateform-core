import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const PRIMARY = 'plateform-audit-archive-primary';
const RECEIVER = 'https://dkbjgvovxgglqhqxmuyb.supabase.co/functions/v1/audit-archive-receiver';
const SOURCE = 'abdxvlykasqmknexxhjo';
const encoder = new TextEncoder();
const hex = (v: ArrayBuffer): string => [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (v: Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(v)));
const b64 = (b: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(out);
};
async function aesKey(channelToken: string): Promise<CryptoKey> {
  if (channelToken.length < 32) throw new Error('ARCHIVE_KEY_WEAK');
  const derived = await crypto.subtle.digest('SHA-256', encoder.encode('plateform-audit-archive-aes-v1:' + channelToken));
  return crypto.subtle.importKey('raw', derived, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function decrypt(key: CryptoKey, raw: Uint8Array): Promise<Uint8Array> {
  if (raw.byteLength < 29) throw new Error('ARCHIVE_SEALED_OBJECT_INVALID');
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) },
    key, raw.slice(12));
  return new Uint8Array(opened);
}
async function encrypt(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv, 0); out.set(sealed, iv.byteLength);
  return out;
}
async function checkedRpc(client: ReturnType<typeof createClient>, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(name.toUpperCase() + '_FAILED');
  return data;
}
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const authenticated = await checkedRpc(client, 'verify_continuity_worker_token', {
    p_token: req.headers.get('x-plateform-worker-token') ?? '',
  }).catch(() => false);
  if (authenticated !== true) return new Response('Not Found', { status: 404 });
  let body: { max_batches?: number } = {};
  try { body = await req.json(); } catch { return Response.json({ status: 'INVALID_INPUT' }, { status: 400 }); }
  const maxBatches = body.max_batches ?? 4;
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 5) {
    return Response.json({ status: 'INVALID_MAX_BATCHES' }, { status: 400 });
  }
  let config: any;
  try {
    config = await checkedRpc(client, 'get_continuity_replica_runtime_config');
    if (config?.target_url !==
      'https://dkbjgvovxgglqhqxmuyb.supabase.co/functions/v1/continuity-replica-receiver'
      || typeof config.channel_token !== 'string'
      || typeof config.target_anon_jwt !== 'string' || config.target_anon_jwt.length < 32
      || RECEIVER.split('/functions/')[0] !== config.target_url.split('/functions/')[0]) {
      throw new Error('AUDIT_ARCHIVE_REPLICA_CONFIG_INVALID');
    }
    const { error: bucketError } = await client.storage.createBucket(PRIMARY, {
      public: false, fileSizeLimit: 2 * 1024 * 1024,
      allowedMimeTypes: ['application/octet-stream'],
    });
    if (bucketError && !/already exists/i.test(bucketError.message)) throw new Error('AUDIT_PRIMARY_BUCKET_UNAVAILABLE');
    const key = await aesKey(config.channel_token);
    const outcomes: { batch_no: number; rows: number; chain_sha256: string }[] = [];
    for (let index = 0; index < maxBatches; index++) {
      const claim = await checkedRpc(client, 'claim_audit_archive_batch');
      if (claim?.status === 'IDLE' || claim?.status === 'BUSY') {
        return Response.json({ status: claim.status, archived: outcomes });
      }
      if (claim?.status !== 'CLAIMED') throw new Error('AUDIT_ARCHIVE_CLAIM_INVALID');
      const lease = String(claim.lease);
      const seq = Number(claim.batch_no);
      const previous = String(claim.previous_chain);
      const response = await checkedRpc(client, 'read_audit_archive_batch', { p_lease: lease, p_limit: 200 });
      const rows = response?.rows;
      if (!Array.isArray(rows) || rows.length > 200) throw new Error('AUDIT_ARCHIVE_PAGE_INVALID');
      if (rows.length === 0) {
        await checkedRpc(client, 'release_empty_audit_archive', { p_lease: lease });
        return Response.json({ status: 'IDLE', archived: outcomes });
      }
      const ending = rows[rows.length - 1];
      const plain = encoder.encode(JSON.stringify({
        version: 1, source: SOURCE, batch_no: seq, previous_chain: previous, rows,
      }));
      const plainSha = await digest(plain);
      const path = 'v1/batch-' + String(seq).padStart(9, '0') + '.bin';
      const storage = client.storage.from(PRIMARY);
      let cipher: Uint8Array;
      const { data: saved, error: fetchError } = await storage.download(path);
      if (saved) {
        cipher = new Uint8Array(await saved.arrayBuffer());
        const recovered = await decrypt(key, cipher);
        if (await digest(recovered) !== plainSha) throw new Error('AUDIT_ARCHIVE_PRIMARY_CONFLICT');
      } else {
        if (fetchError && !/not found|does not exist|404/i.test(fetchError.message)) {
          throw new Error('AUDIT_ARCHIVE_PRIMARY_READ_FAILED');
        }
        cipher = await encrypt(key, plain);
        if (cipher.byteLength > 2097152) throw new Error('AUDIT_ARCHIVE_BATCH_TOO_LARGE');
        const { error: uploadError } = await storage.upload(path, cipher, {
          contentType: 'application/octet-stream', upsert: false, cacheControl: '0',
        });
        if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw new Error('AUDIT_ARCHIVE_PRIMARY_UPLOAD_FAILED');
      }
      const { data: check, error: checkError } = await storage.download(path);
      if (checkError || !check) throw new Error('AUDIT_ARCHIVE_PRIMARY_VERIFY_FAILED');
      cipher = new Uint8Array(await check.arrayBuffer());
      const opened = await decrypt(key, cipher);
      if (await digest(opened) !== plainSha) throw new Error('AUDIT_ARCHIVE_PRIMARY_READBACK_MISMATCH');
      const sha = await digest(cipher);
      const chain = await digest(encoder.encode(previous + ':' + seq + ':' + sha + ':' + plainSha + ':' + rows.length + ':' + ending.id));
      const replicaRes = await fetch(RECEIVER, {
        method: 'POST', headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + config.target_anon_jwt,
          apikey: config.target_anon_jwt,
          'x-plateform-source': SOURCE,
          'x-plateform-replica-token': config.channel_token,
        },
        body: JSON.stringify({
          action: 'attest', batch_no: seq, row_count: rows.length,
          upper_event_id: ending.id, object_path: path,
          payload_sha256: sha, plaintext_sha256: plainSha,
          previous_chain_sha256: previous, chain_sha256: chain,
          ciphertext_b64: b64(cipher),
        }), signal: AbortSignal.timeout(30000),
      });
      if (!replicaRes.ok) throw new Error('AUDIT_ARCHIVE_REPLICA_HTTP_FAILED');
      const witness = await replicaRes.json();
      if (witness.status !== 'ATTESTED' || witness.sha256 !== sha || witness.chain_sha256 !== chain
        || witness.byte_count !== cipher.byteLength) throw new Error('AUDIT_ARCHIVE_REPLICA_NOT_VERIFIED');
      const done = await checkedRpc(client, 'finish_audit_archive_batch', {
        p_lease: lease, p_ending_at: ending.timestamp, p_ending_id: ending.id,
        p_row_count: rows.length, p_payload_sha256: sha,
        p_plaintext_sha256: plainSha, p_chain_sha256: chain, p_path: path,
      });
      if (done?.status !== 'SEALED' || done.chain_sha256 !== chain) throw new Error('AUDIT_ARCHIVE_COMMIT_NOT_VERIFIED');
      outcomes.push({ batch_no: seq, rows: rows.length, chain_sha256: chain });
    }
    return Response.json({ status: 'PROGRESSED', archived: outcomes });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'AUDIT_ARCHIVE_UNKNOWN';
    console.error('audit archive halted', code);
    return Response.json({ status: 'FAILED', code }, { status: 500 });
  }
});
