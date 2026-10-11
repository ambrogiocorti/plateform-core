import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

const BUCKET = 'plateform-continuity-primary';
const TARGET = 'https://dkbjgvovxgglqhqxmuyb.supabase.co/functions/v1/continuity-replica-receiver';
const SOURCE = 'abdxvlykasqmknexxhjo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const workerToken = req.headers.get('x-plateform-worker-token') ?? '';
  const { data: authenticated, error: authError } = await client.rpc(
    'verify_continuity_worker_token',
    { p_token: workerToken },
  );
  if (authError || authenticated !== true) return new Response('Not Found', { status: 404 });

  let body: { limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ status: 'INVALID_INPUT' }, { status: 400 });
  }
  const limit = body.limit === undefined ? 8 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 15) {
    return Response.json({ status: 'INVALID_LIMIT' }, { status: 400 });
  }

  try {
    const { data: config, error: configError } = await client.rpc(
      'get_continuity_replica_runtime_config',
    );
    if (
      configError ||
      config?.target_url !== TARGET ||
      !config?.target_anon_jwt ||
      !config?.channel_token
    ) {
      return Response.json({ status: 'BLOCKED', code: 'REPLICA_CONFIG_INVALID' }, { status: 503 });
    }

    const { data: ids, error: listError } = await client.rpc(
      'list_failed_continuity_storage_cleanup',
      { p_limit: limit },
    );
    if (listError || !Array.isArray(ids)) throw new Error('CANDIDATE_QUERY_FAILED');

    let removedPrimary = 0;
    let removedReplica = 0;
    const cleaned: string[] = [];
    for (const row of ids) {
      const backupId = String(row.backup_id ?? '');
      if (!UUID.test(backupId)) throw new Error('INVALID_CANDIDATE');

      const { data: valid, error: validError } = await client
        .from('backup_metadata')
        .select('status,integrity_verified')
        .eq('id', backupId)
        .single();
      if (validError || valid?.status !== 'FAILED' || valid?.integrity_verified !== false) {
        throw new Error('CANDIDATE_STATE_CHANGED');
      }
      const { data: restores, error: restoresError } = await client
        .from('restore_jobs')
        .select('id')
        .or('backup_id.eq.' + backupId + ',pre_restore_backup_id.eq.' + backupId)
        .limit(1);
      if (restoresError || (restores?.length ?? 0) !== 0) {
        throw new Error('CANDIDATE_REFERENCED_BY_RESTORE');
      }

      // Purge replica first. If the primary removal fails, a later retry can
      // still select the backup by its surviving primary object rows.
      const replicaResponse = await fetch(TARGET, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + String(config.target_anon_jwt),
          apikey: String(config.target_anon_jwt),
          'x-plateform-source': SOURCE,
          'x-plateform-replica-token': String(config.channel_token),
        },
        body: JSON.stringify({ action: 'purge', backup_id: backupId }),
        signal: AbortSignal.timeout(25000),
      });
      if (!replicaResponse.ok) throw new Error('REPLICA_PURGE_HTTP_FAILED');
      const replicaData = await replicaResponse.json();
      if (replicaData?.status !== 'PURGED') throw new Error('REPLICA_PURGE_UNVERIFIED');

      let primaryFiles = 0;
      for (;;) {
        const { data: files, error: filesError } = await client.storage
          .from(BUCKET)
          .list(backupId, { limit: 1000, offset: 0 });
        if (filesError) throw new Error('PRIMARY_LIST_FAILED');
        const paths = (files ?? [])
          .filter((x) => Boolean(x.name) && !x.id?.endsWith('/'))
          .map((x) => backupId + '/' + x.name);
        if (!paths.length) break;
        const { error: removalError } = await client.storage.from(BUCKET).remove(paths);
        if (removalError) throw new Error('PRIMARY_REMOVE_FAILED');
        primaryFiles += paths.length;
        if (paths.length < 1000) break;
      }
      removedPrimary += primaryFiles;
      removedReplica += Number(replicaData.deleted_files ?? 0);
      cleaned.push(backupId);
    }

    return Response.json({
      status: 'SUCCEEDED',
      deleted_backup_folders: cleaned.length,
      deleted_primary_files: removedPrimary,
      deleted_replica_files: removedReplica,
      backup_ids: cleaned,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    console.error('failed backup storage cleanup halted', code);
    return Response.json({ status: 'FAILED', code }, { status: 500 });
  }
});
