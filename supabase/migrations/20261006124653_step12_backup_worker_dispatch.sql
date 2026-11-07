
create or replace function private.dispatch_continuity_backup_worker()
returns bigint
language plpgsql
security definer
set search_path='pg_catalog','private','net'
as $$
declare
  c private.continuity_worker_runtime_config;
  request_id bigint;
begin
  select * into strict c
  from private.continuity_worker_runtime_config
  where id;

  select net.http_post(
    url:=c.function_url,
    body:=jsonb_build_object('source','cron','worker','BACKUP'),
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
$$;

revoke all on function private.dispatch_continuity_backup_worker()
from public,anon,authenticated;
