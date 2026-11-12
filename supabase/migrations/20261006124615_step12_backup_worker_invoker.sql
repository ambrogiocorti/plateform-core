
create or replace function public.invoke_continuity_backup_worker()
returns bigint
language plpgsql
security definer
set search_path='pg_catalog','public','private','net'
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
    body:='{"action":"run"}'::jsonb,
    params:='{}'::jsonb,
    headers:=jsonb_build_object(
      'Authorization','Bearer '||c.function_anon_jwt,
      'apikey',c.function_anon_jwt,
      'Content-Type','application/json',
      'x-plateform-worker-token',c.worker_token
    ),
    timeout_milliseconds:=15000
  ) into request_id;

  return request_id;
end
$$;

revoke all on function public.invoke_continuity_backup_worker()
from public,anon,authenticated;
grant execute on function public.invoke_continuity_backup_worker()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.invoke_continuity_backup_worker()','service_role')
on conflict do nothing;
