
create table if not exists private.continuity_worker_runtime_config (
  id boolean primary key default true check(id),
  worker_token text not null check(length(worker_token) between 64 and 256),
  function_url text not null check(length(function_url) between 8 and 2048),
  function_anon_jwt text not null check(length(function_anon_jwt) between 40 and 4096),
  replica_target_url text not null check(length(replica_target_url) between 8 and 2048),
  replica_target_anon_jwt text not null check(length(replica_target_anon_jwt) between 40 and 4096),
  replica_channel_token text not null check(length(replica_channel_token) between 64 and 256),
  updated_at timestamptz not null default clock_timestamp()
);

alter table private.continuity_worker_runtime_config enable row level security;
revoke all on private.continuity_worker_runtime_config from public,anon,authenticated;

create or replace function public.verify_continuity_worker_token(p_token text)
returns boolean
language sql
stable
security definer
set search_path='pg_catalog','private','extensions'
as $$
  select exists(
    select 1
    from private.continuity_worker_runtime_config c
    where c.id
      and encode(extensions.digest(convert_to(c.worker_token,'utf8'),'sha256'),'hex')
          = encode(extensions.digest(convert_to(coalesce(p_token,''),'utf8'),'sha256'),'hex')
  )
$$;

revoke all on function public.verify_continuity_worker_token(text)
from public,anon,authenticated;
grant execute on function public.verify_continuity_worker_token(text) to service_role;

create or replace function public.get_continuity_replica_runtime_config()
returns jsonb
language sql
stable
security definer
set search_path='pg_catalog','private'
as $$
  select jsonb_build_object(
    'target_url',c.replica_target_url,
    'target_anon_jwt',c.replica_target_anon_jwt,
    'channel_token',c.replica_channel_token
  )
  from private.continuity_worker_runtime_config c
  where c.id
$$;

revoke all on function public.get_continuity_replica_runtime_config()
from public,anon,authenticated;
grant execute on function public.get_continuity_replica_runtime_config() to service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.verify_continuity_worker_token(text)','service_role'),
  ('public.get_continuity_replica_runtime_config()','service_role')
on conflict do nothing;
