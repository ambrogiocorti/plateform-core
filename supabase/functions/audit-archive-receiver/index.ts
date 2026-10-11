import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const SOURCE_REF = 'abdxvlykasqmknexxhjo';
const BUCKET = 'plateform-audit-archive-replica';
const SHA = /^[a-f0-9]{64}$/;
const base64Bytes = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
async function digest(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const token = req.headers.get('x-plateform-replica-token') ?? '';
  const source = req.headers.get('x-plateform-source') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: allowed, error: authError } = await supabase.rpc('verify_continuity_replica_token', {
    p_source_project_ref: source,
    p_token: token,
  });
  if (authError || allowed !== true || source !== SOURCE_REF) return new Response('Not Found', { status: 404 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ status: 'INVALID_INPUT' }, { status: 400 }); }
  const seq = Number(body.batch_no);
  const expected = String(body.payload_sha256 ?? '');
  const plain = String(body.plaintext_sha256 ?? '');
  const previous = String(body.previous_chain_sha256 ?? '');
  const chain = String(body.chain_sha256 ?? '');
  const count = Number(body.row_count);
  const upperId = String(body.upper_event_id ?? '');
  const path = 'v1/batch-' + String(seq).padStart(9, '0') + '.bin';
  if (body.action !== 'attest' || !Number.isInteger(seq) || seq < 1 || seq > 100000000
     || ![expected,plain,previous,chain].every((x) => SHA.test(x))
     || !Number.isInteger(count) || count < 1 || count > 500
     || !/^[a-f\d-]{36}$/i.test(upperId)
     || String(body.object_path ?? '') !== path
     || typeof body.ciphertext_b64 !== 'string' || body.ciphertext_b64.length > 2800000) {
    return Response.json({ status: 'INVALID_ARCHIVE' }, { status: 400 });
  }
  let bytes: Uint8Array;
  try { bytes = base64Bytes(body.ciphertext_b64 as string); }
  catch { return Response.json({ status: 'INVALID_PAYLOAD' }, { status: 400 }); }
  if (bytes.byteLength < 32 || bytes.byteLength > 2097152 || await digest(bytes) !== expected) {
    return Response.json({ status: 'DIGEST_MISMATCH' }, { status: 400 });
  }
  try {
    const { error: bucketError } = await supabase.storage.createBucket(BUCKET, {
      public: false, fileSizeLimit: 2 * 1024 * 1024,
      allowedMimeTypes: ['application/octet-stream'],
    });
    if (bucketError && !bucketError.message.toLowerCase().includes('already exists')) {
      throw new Error('ARCHIVE_REPLICA_BUCKET_UNAVAILABLE');
    }
    const storage = supabase.storage.from(BUCKET);
    const { error: uploadError } = await storage.upload(path, bytes, {
      contentType: 'application/octet-stream', upsert: false, cacheControl: '0',
    });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) {
      throw new Error('ARCHIVE_REPLICA_WRITE_FAILED');
    }
    const { data: downloaded, error: downloadError } = await storage.download(path);
    if (downloadError || !downloaded) throw new Error('ARCHIVE_REPLICA_READBACK_FAILED');
    const stored = new Uint8Array(await downloaded.arrayBuffer());
    if (stored.byteLength !== bytes.byteLength || await digest(stored) !== expected) {
      throw new Error('ARCHIVE_REPLICA_READBACK_MISMATCH');
    }
    const { data: witnessed, error: witnessError } = await supabase.rpc('attest_audit_archive_replica', {
      p_batch_no: seq, p_payload_sha256: expected, p_plaintext_sha256: plain,
      p_previous_chain: previous, p_chain: chain,
      p_row_count: count, p_upper_event_id: upperId,
      p_object_path: path, p_byte_count: stored.byteLength,
    });
    if (witnessError || witnessed !== true) throw new Error('ARCHIVE_REPLICA_ATTEST_FAILED');
    return Response.json({
      status: 'ATTESTED', batch_no: seq, sha256: expected,
      chain_sha256: chain, byte_count: stored.byteLength,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ARCHIVE_REPLICA_UNKNOWN';
    console.error('audit archive replica', code);
    return Response.json({ status: 'FAILED', code }, { status: 500 });
  }
});
