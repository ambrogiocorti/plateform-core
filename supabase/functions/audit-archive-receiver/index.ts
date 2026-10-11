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
  if (body.action === 'recover') {
    const seq = Number(body.batch_no);
    if (!Number.isInteger(seq) || seq < 1 || seq > 100000000) {
      return Response.json({ status: 'INVALID_BATCH' }, { status: 400 });
    }
    try {
      const { data: rows, error: listError } = await supabase.rpc('list_audit_archive_witnesses', {
        p_after: seq-1,p_limit:1,
      });
      if (listError || !Array.isArray(rows) || rows.length !== 1 || rows[0].batch_no !== seq) {
        throw new Error('AUDIT_RECOVERY_WITNESS_NOT_FOUND');
      }
      const witness = rows[0];
      const { data: file, error } = await supabase.storage.from(BUCKET).download(witness.object_path);
      if (error || !file) throw new Error('AUDIT_RECOVERY_OBJECT_MISSING');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== witness.byte_count || await digest(bytes) !== witness.payload_sha256) {
        throw new Error('AUDIT_RECOVERY_DIGEST_MISMATCH');
      }
      let encoded = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        encoded += String.fromCharCode(...bytes.subarray(i,i+8192));
      }
      return Response.json({
        status:'RECOVERED_CIPHERTEXT',batch_no:seq,sha256:witness.payload_sha256,
        chain_sha256:witness.chain_sha256,object_bytes:bytes.length,ciphertext_b64:btoa(encoded),
      },{headers:{'cache-control':'no-store'}});
    } catch (err) {
      const code = err instanceof Error?err.message:'AUDIT_RECOVERY_FAILED';
      console.error('audit recovery',code);
      return Response.json({status:'FAILED',code},{status:500});
    }
  }
  if (body.action === 'verify') {
    const after = Number(body.after_batch ?? 0);
    const limit = Number(body.limit ?? 30);
    if (!Number.isInteger(after) || after<0 || !Number.isInteger(limit) || limit<1 || limit>30) {
      return Response.json({ status: 'INVALID_VERIFY_WINDOW' }, { status: 400 });
    }
    try {
      const { data: rows, error: listError } = await supabase.rpc('list_audit_archive_witnesses', {
        p_after: after, p_limit: limit,
      });
      if (listError || !Array.isArray(rows)) throw new Error('AUDIT_WITNESS_LIST_FAILED');
      let previous = rows[0]?.previous_chain_sha256 ?? '0'.repeat(64);
      let nextBatch = after+1;
      let checkedRows = 0;
      for (const row of rows) {
        if (row.batch_no !== nextBatch || row.previous_chain_sha256 !== previous) {
          throw new Error('AUDIT_WITNESS_SEQUENCE_INVALID');
        }
        const expectedChain = await digest(new TextEncoder().encode(
          previous + ':' + row.batch_no + ':' + row.payload_sha256 + ':' +
          row.plaintext_sha256 + ':' + row.row_count + ':' + row.upper_event_id
        ));
        if (expectedChain !== row.chain_sha256) throw new Error('AUDIT_WITNESS_CHAIN_INVALID');
        const { data: payload, error: downloadError } = await supabase.storage.from(BUCKET).download(row.object_path);
        if (downloadError || !payload) throw new Error('AUDIT_WITNESS_OBJECT_MISSING');
        const bytes = new Uint8Array(await payload.arrayBuffer());
        if (bytes.byteLength !== row.byte_count || await digest(bytes) !== row.payload_sha256) {
          throw new Error('AUDIT_WITNESS_PAYLOAD_MISMATCH');
        }
        previous = row.chain_sha256;
        checkedRows += row.row_count;
        nextBatch++;
      }
      return Response.json({
        status:'VERIFIED',checked_batches:rows.length,checked_rows:checkedRows,
        last_batch:nextBatch-1,last_chain_sha256:previous,
      },{headers:{'cache-control':'no-store'}});
    } catch (err) {
      const code = err instanceof Error?err.message:'AUDIT_VERIFY_FAILED';
      console.error('audit witness verify',code);
      return Response.json({status:'FAILED',code},{status:500});
    }
  }
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
