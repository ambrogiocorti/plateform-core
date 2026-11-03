-- Staging replay 2026-10-19 (plateform-staging, fresh install of the 485-file
-- chain): six database callers of Edge Functions hard-coded the Development
-- project URL, so every other installation (one Supabase project per client)
-- would dispatch its workers to Development, and pg_net was never created by
-- the chain (Development had it enabled by hand), so those callers failed with
-- `schema "net" does not exist`. Additive: no row is read for rewriting,
-- deleted or modified; function bodies change only in the URL they target.
begin;

-- Conditional only so the local PGlite/PostgreSQL harnesses (no pg_net
-- binaries) can replay the chain; every Supabase project ships pg_net.
do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end $$;

-- Base URL of this installation's Edge Functions, e.g.
-- https://<project-ref>.supabase.co/functions/v1/ . Taken from the Vault secret
-- `plateform_edge_functions_base_url` when present, otherwise derived from the
-- continuity worker URL already configured per installation. Never defaults to
-- another project: an unconfigured installation fails loudly.
create or replace function private.edge_function_url(p_function text)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_base text;
begin
  if p_function is null or p_function !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'INVALID_EDGE_FUNCTION_NAME';
  end if;

  select decrypted_secret into v_base
  from vault.decrypted_secrets
  where name='plateform_edge_functions_base_url'
  order by created_at desc
  limit 1;

  if v_base is null then
    select substring(c.function_url from '^(https://[^/]+/functions/v1/)')
    into v_base
    from private.continuity_worker_runtime_config c
    where c.id;
  end if;

  if v_base is null then
    raise exception 'EDGE_FUNCTIONS_BASE_URL_NOT_CONFIGURED';
  end if;
  v_base:=rtrim(v_base,'/')||'/';
  if v_base !~ '^https://[a-z0-9.-]+/functions/v1/$' then
    raise exception 'EDGE_FUNCTIONS_BASE_URL_INVALID';
  end if;

  return v_base||p_function;
end
$$;

revoke all on function private.edge_function_url(text) from public, anon, authenticated, service_role;

create or replace function public.invoke_reservation_message_worker(p_max_jobs integer default 20)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_max_jobs is null or p_max_jobs not between 1 and 50 then
    raise exception 'INVALID_MAX_JOBS';
  end if;

  select decrypted_secret
  into v_token
  from vault.decrypted_secrets
  where name='plateform_message_worker_token'
  order by created_at desc
  limit 1;

  if v_token is null or length(v_token)<32 then
    raise exception 'MESSAGE_WORKER_TOKEN_MISSING';
  end if;

  v_request_id:=net.http_post(
    url:=private.edge_function_url('reservation-message-worker'),
    body:=jsonb_build_object('max_jobs',p_max_jobs),
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-plateform-worker-token',v_token
    ),
    timeout_milliseconds:=10000
  );

  return jsonb_build_object(
    'queued',true,
    'request_id',v_request_id
  );
end
$function$;

create or replace function public.invoke_reservation_deposit_no_show_worker(p_max_jobs integer default 10)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_max_jobs is null or p_max_jobs not between 1 and 25 then
    raise exception 'INVALID_MAX_JOBS';
  end if;

  select decrypted_secret
  into v_token
  from vault.decrypted_secrets
  where name='plateform_no_show_deposit_worker_token'
  order by created_at desc
  limit 1;

  if v_token is null or length(v_token)<32 then
    raise exception 'NO_SHOW_DEPOSIT_WORKER_TOKEN_MISSING';
  end if;

  v_request_id:=net.http_post(
    url:=private.edge_function_url('reservation-deposit-no-show-worker'),
    body:=jsonb_build_object('max_jobs',p_max_jobs),
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-plateform-worker-token',v_token
    ),
    timeout_milliseconds:=10000
  );

  return jsonb_build_object(
    'queued',true,
    'request_id',v_request_id
  );
end
$function$;

create or replace function public.invoke_database_unavailable_chaos_probe()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_token text;
  v_request_id bigint;
begin
  select decrypted_secret
  into v_token
  from vault.decrypted_secrets
  where name='plateform_database_chaos_probe_token'
  order by created_at desc
  limit 1;

  if v_token is null or length(v_token)<32 then
    raise exception 'DATABASE_CHAOS_PROBE_TOKEN_MISSING';
  end if;

  v_request_id:=net.http_post(
    url:=private.edge_function_url('database-unavailable-chaos-probe'),
    body:='{}'::jsonb,
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-plateform-chaos-token',v_token
    ),
    timeout_milliseconds:=15000
  );

  return jsonb_build_object(
    'queued',true,
    'request_id',v_request_id
  );
end
$function$;

create or replace function private.dispatch_continuity_retention_worker()
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog', 'private', 'net'
as $function$
declare
  c private.continuity_worker_runtime_config;
  request_id bigint;
begin
  select * into strict c
  from private.continuity_worker_runtime_config
  where id;

  select net.http_post(
    url:=private.edge_function_url('continuity-retention-worker'),
    body:=jsonb_build_object('source','cron','worker','RETENTION'),
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'content-type','application/json',
      'authorization','Bearer '||c.function_anon_jwt,
      'apikey',c.function_anon_jwt,
      'x-plateform-worker-token',c.worker_token
    ),
    timeout_milliseconds:=5000
  )
  into request_id;

  return request_id;
end
$function$;

-- Same schedules and conditions as 20261011153304; only the URL changes.
-- cron.schedule with an existing job name replaces that job's command.
select cron.schedule(
 'plateform-audit-archive-encrypted',
 '*/15 * * * *',
 $archive$
 SELECT net.http_post(
  url:=private.edge_function_url('audit-archive-worker'),
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

select cron.schedule(
 'plateform-audit-archive-recovery-verify',
 '17 3 * * *',
 $verify$
 SELECT net.http_post(
  url:=private.edge_function_url('audit-archive-verify'),
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

-- Fail the migration if any database caller still targets a fixed project.
do $$
begin
  if exists(select 1 from pg_proc where prosrc ~ '[a-z0-9]{20}\.supabase\.co')
     or exists(select 1 from cron.job where command ~ '[a-z0-9]{20}\.supabase\.co') then
    raise exception 'HARDCODED_PROJECT_URL_REMAINS';
  end if;
end $$;

commit;
