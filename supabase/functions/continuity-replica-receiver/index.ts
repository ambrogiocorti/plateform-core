import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const BUCKET = 'plateform-continuity-replica';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const token = req.headers.get('x-plateform-replica-token') ?? '';
  const sourceRef = req.headers.get('x-plateform-source') ?? '';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  async function aggregateFiles(backupId: string) {
    const { data: listed, error: listError } = await supabase.storage
      .from(BUCKET)
      .list(backupId, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (listError) throw new Error('REPLICA_LIST_FAILED');

    const files = (listed ?? []).filter((x) => x.name && !x.id?.endsWith('/'));
    const parts: string[] = [];
    let totalBytes = 0;

    for (const file of files) {
      const path = `${backupId}/${file.name}`;
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error('REPLICA_DOWNLOAD_FAILED');
      const bytes = new Uint8Array(await data.arrayBuffer());
      totalBytes += bytes.byteLength;
      parts.push(`${file.name}:${await sha256Hex(bytes)}`);
    }

    const aggregate = await sha256Hex(new TextEncoder().encode(parts.join('|')));
    return { file_count: files.length, total_bytes: totalBytes, aggregate_hash: aggregate };
  }

  const { data: allowed, error: verifyError } = await supabase.rpc(
    'verify_continuity_replica_token',
    { p_source_project_ref: sourceRef, p_token: token },
  );
  if (verifyError || allowed !== true || !/^[a-z0-9]{20}$/.test(sourceRef)) {
    return new Response('Not Found', { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Side-effect-free with respect to backup snapshots. Validate the authenticated
  // receiver and the replica Storage bucket before the source claims a backup.
  if (body?.action === 'preflight') {
    const targetUrl = Deno.env.get('SUPABASE_URL') ?? '';
    let projectRef: string;
    try {
      const parts = new URL(targetUrl).hostname.split('.');
      if (
        parts.length !== 3 ||
        parts[1] !== 'supabase' ||
        parts[2] !== 'co' ||
        !/^[a-z0-9]{20}$/.test(parts[0] ?? '')
      ) {
        throw new Error('INVALID_TARGET_URL');
      }
      projectRef = parts[0] ?? '';
    } catch {
      return Response.json({ status: 'TARGET_IDENTITY_INVALID' }, { status: 503 });
    }
    const { data: bucket, error: storageError } = await supabase.storage.getBucket(BUCKET);
    if (storageError || !bucket || bucket.id !== BUCKET || bucket.public !== false) {
      return Response.json({ status: 'REPLICA_STORAGE_UNAVAILABLE' }, { status: 503 });
    }
    return Response.json(
      { status: 'READY', project_ref: projectRef },
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  }

  const backupId = String(body?.backup_id ?? '');
  if (!UUID_RE.test(backupId)) return new Response('Invalid backup', { status: 400 });

  const { error: bucketError } = await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 8 * 1024 * 1024,
  });
  if (bucketError && !String(bucketError.message).toLowerCase().includes('already exists')) {
    return Response.json({ status: 'BUCKET_FAILED' }, { status: 500 });
  }

  try {
    if (body.action === 'init') {
      const manifest = body.manifest ?? {};
      const hmac = String(body.manifest_hmac ?? '');
      const envelopeB64 = String(body.key_envelope_b64 ?? '');
      const migrationBundle = body.migration_bundle ?? {};
      const migrationHash = String(body.migration_hash ?? '');

      if (
        !/^[0-9a-f]{64}$/.test(hmac) ||
        !/^[0-9a-f]{64}$/.test(migrationHash) ||
        envelopeB64.length < 32 ||
        Number(migrationBundle?.count ?? -1) < 1 ||
        String(migrationBundle?.aggregate_sha256 ?? '') !== migrationHash ||
        String(manifest?.components?.migrations?.aggregate_sha256 ?? '') !== migrationHash ||
        Number(manifest?.components?.migrations?.count ?? -1) !==
          Number(migrationBundle?.count ?? -2) ||
        String(manifest?.components?.migrations?.latest_version ?? '') !==
          String(migrationBundle?.latest_version ?? '')
      ) {
        return new Response('Invalid metadata', { status: 400 });
      }

      const { data: escrowed, error: escrowError } = await supabase.rpc(
        'persist_continuity_replica_recovery_token',
        { p_source_project_ref: sourceRef, p_token: token },
      );
      if (escrowError || escrowed !== true) throw new Error('RECOVERY_TOKEN_ESCROW_FAILED');

      const { data: envelopeCheck, error: envelopeError } = await supabase.rpc(
        'verify_continuity_replica_key_envelope',
        { p_envelope_b64: envelopeB64 },
      );
      if (envelopeError || String(envelopeCheck?.backup_id ?? '') !== backupId) {
        throw new Error('KEY_ENVELOPE_VERIFY_FAILED');
      }

      const uploads = [
        ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest)), 'application/json'],
        ['manifest.hmac', new TextEncoder().encode(hmac + '\n'), 'text/plain'],
        ['key-envelope.bin', b64ToBytes(envelopeB64), 'application/octet-stream'],
        [
          'migrations.json',
          new TextEncoder().encode(JSON.stringify(migrationBundle)),
          'application/json',
        ],
        ['migration-history.sha256', new TextEncoder().encode(migrationHash + '\n'), 'text/plain'],
      ] as const;

      for (const [name, bytes, contentType] of uploads) {
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(`${backupId}/${name}`, bytes, { upsert: true, contentType, cacheControl: '0' });
        if (error) throw new Error('REPLICA_UPLOAD_FAILED');
      }

      return Response.json({
        status: 'INITIALIZED',
        backup_id: backupId,
        key_escrow: true,
        migration_bundle: true,
        backup_key_sha256: envelopeCheck.backup_key_sha256,
        manifest_hmac_key_sha256: envelopeCheck.manifest_hmac_key_sha256,
      });
    }

    if (body.action === 'chunk') {
      const chunkNo = Number(body.chunk_no);
      const cipherB64 = String(body.cipher_b64 ?? '');
      if (!Number.isInteger(chunkNo) || chunkNo < 0 || chunkNo > 100000 || cipherB64.length < 8) {
        return new Response('Invalid chunk', { status: 400 });
      }

      const bytes = b64ToBytes(cipherB64);
      const name = `chunk-${String(chunkNo).padStart(6, '0')}.bin`;
      const { error } = await supabase.storage.from(BUCKET).upload(`${backupId}/${name}`, bytes, {
        upsert: true,
        contentType: 'application/octet-stream',
        cacheControl: '0',
      });
      if (error) throw new Error('REPLICA_CHUNK_UPLOAD_FAILED');

      return Response.json({
        status: 'CHUNK_STORED',
        backup_id: backupId,
        chunk_no: chunkNo,
        bytes: bytes.byteLength,
        cipher_sha256: await sha256Hex(bytes),
      });
    }

    if (body.action === 'purge') {
      let deleted = 0;
      for (;;) {
        const { data: listed, error: listError } = await supabase.storage
          .from(BUCKET)
          .list(backupId, { limit: 1000, offset: 0 });
        if (listError) throw new Error('REPLICA_PURGE_LIST_FAILED');

        const paths = (listed ?? []).filter((x) => x.name).map((x) => `${backupId}/${x.name}`);

        if (paths.length === 0) break;

        const { error: removeError } = await supabase.storage.from(BUCKET).remove(paths);
        if (removeError) throw new Error('REPLICA_PURGE_FAILED');

        deleted += paths.length;
        if (paths.length < 1000) break;
      }

      return Response.json({
        status: 'PURGED',
        backup_id: backupId,
        deleted_files: deleted,
      });
    }

    if (body.action === 'finalize') {
      const summary = await aggregateFiles(backupId);
      return Response.json({ status: 'VERIFIED', backup_id: backupId, ...summary });
    }

    return new Response('Invalid action', { status: 400 });
  } catch (error) {
    console.error('replica receiver failure', error);
    return Response.json({ status: 'FAILED' }, { status: 500 });
  }
});
