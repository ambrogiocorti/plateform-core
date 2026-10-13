-- Automatic audit archiving and independent daily recovery check. Never delete audit rows.
SELECT cron.schedule(
 'plateform-audit-archive-encrypted',
 '*/15 * * * *',
 $archive$
 SELECT net.http_post(
  url:='https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/audit-archive-worker',
  body:='{"max_batches":5}'::jsonb,
  headers:=jsonb_build_object('content-type','application/json',
    'authorization','Bearer '||c.function_anon_jwt,
    'apikey',c.function_anon_jwt,
    'x-plateform-worker-token',c.worker_token),
  timeout_milliseconds:=90000
 ) FROM private.continuity_worker_runtime_config c WHERE c.id
 AND EXISTS(
 SELECT 1 FROM private.audit_archive_cursor s JOIN public.audit_log a
 ON (a.timestamp,a.id)>(s.last_event_at,s.last_event_id)
 WHERE s.id AND a.timestamp<now()-interval '5 minutes'
 );
 $archive$
);
SELECT cron.schedule(
 'plateform-audit-archive-recovery-verify',
 '17 3 * * *',
 $verify$
 SELECT net.http_post(
  url:='https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/audit-archive-verify',
  body:='{}'::jsonb,
  headers:=jsonb_build_object('content-type','application/json',
    'authorization','Bearer '||c.function_anon_jwt,
    'apikey',c.function_anon_jwt,
    'x-plateform-worker-token',c.worker_token),
  timeout_milliseconds:=90000
 ) FROM private.continuity_worker_runtime_config c WHERE c.id
 AND EXISTS(SELECT 1 FROM private.audit_archive_batches);
 $verify$
);
