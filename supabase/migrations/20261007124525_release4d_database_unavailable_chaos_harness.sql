
create table if not exists private.database_chaos_probe(
  id uuid primary key,
  marker text not null check(length(marker) between 1 and 200),
  created_at timestamptz not null default clock_timestamp()
);

alter table private.database_chaos_probe enable row level security;
revoke all on private.database_chaos_probe from public,anon,authenticated;

create or replace function public.write_database_chaos_probe(
  p_id uuid,
  p_marker text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if p_id is null
     or p_marker is null
     or length(p_marker) not between 1 and 200
  then
    raise exception 'INVALID_CHAOS_PROBE';
  end if;

  insert into private.database_chaos_probe(id,marker)
  values(p_id,p_marker)
  on conflict(id) do update
  set marker=excluded.marker;

  return jsonb_build_object(
    'id',p_id,
    'written',true
  );
end
$$;

revoke all on function public.write_database_chaos_probe(uuid,text)
from public,anon,authenticated;
grant execute on function public.write_database_chaos_probe(uuid,text)
to service_role,postgres;

create or replace function public.read_database_chaos_probe(
  p_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'exists',
    exists(
      select 1
      from private.database_chaos_probe
      where id=p_id
    ),
    'marker',
    (
      select marker
      from private.database_chaos_probe
      where id=p_id
    )
  )
$$;

revoke all on function public.read_database_chaos_probe(uuid)
from public,anon,authenticated;
grant execute on function public.read_database_chaos_probe(uuid)
to service_role,postgres;

create or replace function public.delete_database_chaos_probe(
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_deleted integer;
begin
  delete from private.database_chaos_probe
  where id=p_id;

  get diagnostics v_deleted=row_count;

  return jsonb_build_object(
    'id',p_id,
    'deleted',v_deleted>0
  );
end
$$;

revoke all on function public.delete_database_chaos_probe(uuid)
from public,anon,authenticated;
grant execute on function public.delete_database_chaos_probe(uuid)
to service_role,postgres;

create or replace function private.cleanup_database_chaos_probe()
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare
  v_deleted integer;
begin
  delete from private.database_chaos_probe
  where created_at<clock_timestamp()-interval '1 hour';
  get diagnostics v_deleted=row_count;
  return v_deleted;
end
$$;

revoke all on function private.cleanup_database_chaos_probe()
from public,anon,authenticated;
grant execute on function private.cleanup_database_chaos_probe()
to service_role,postgres;

do $$
begin
  if not exists(
    select 1
    from vault.decrypted_secrets
    where name='plateform_database_chaos_probe_token'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32),'hex'),
      'plateform_database_chaos_probe_token',
      'Internal token for database unavailable chaos probe',
      null
    );
  end if;
end
$$;

create or replace function public.invoke_database_unavailable_chaos_probe()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
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
    url:='https://abdxvlykasqmknexxhjo.supabase.co/functions/v1/database-unavailable-chaos-probe',
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
$$;

revoke all on function public.invoke_database_unavailable_chaos_probe()
from public,anon,authenticated;
grant execute on function public.invoke_database_unavailable_chaos_probe()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values
  ('public.write_database_chaos_probe(uuid,text)','service_role'),
  ('public.read_database_chaos_probe(uuid)','service_role'),
  ('public.delete_database_chaos_probe(uuid)','service_role'),
  ('public.invoke_database_unavailable_chaos_probe()','service_role')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'DATABASE_UNAVAILABLE_CONTROLLED_CHAOS',
  'CHAOS',
  true,
  'Internal Edge chaos harness forces the database transport to fail before a service-role mutation request, verifies explicit failure and zero mutation, then proves the same mutation succeeds with healthy transport and cleans the sentinel.'
)
on conflict(key) do nothing;
