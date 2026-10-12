
create or replace function private.normalize_api_permission_manifest_entry()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_oid oid;
  v_schema text;
  v_name text;
  v_args text;
begin
  begin
    v_oid:=to_regprocedure(new.function_identity)::oid;
  exception when others then
    raise exception 'INVALID_API_PERMISSION_FUNCTION';
  end;

  if v_oid is null then
    raise exception 'INVALID_API_PERMISSION_FUNCTION';
  end if;

  select n.nspname,p.proname,
         replace(pg_catalog.oidvectortypes(p.proargtypes),', ',',')
    into v_schema,v_name,v_args
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where p.oid=v_oid
    and p.prokind='f'
    and n.nspname in ('public','private');

  if v_schema is null then
    raise exception 'INVALID_API_PERMISSION_SCHEMA';
  end if;

  new.function_identity:=format('%I.%I(%s)',v_schema,v_name,v_args);
  return new;
end
$$;

drop trigger if exists api_permission_manifest_normalize
on private.api_permission_manifest;

create trigger api_permission_manifest_normalize
before insert or update of function_identity
on private.api_permission_manifest
for each row
execute function private.normalize_api_permission_manifest_entry();

update private.api_permission_manifest
set function_identity=function_identity;

create or replace function private.api_permission_manifest_report()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_anon_actual integer;
  v_auth_actual integer;
  v_anon_manifest integer;
  v_auth_manifest integer;
  v_anon_undocumented integer;
  v_auth_undocumented integer;
  v_anon_missing integer;
  v_auth_missing integer;
begin
  with roles(api_role,role_oid) as (
    select rolname,oid
    from pg_catalog.pg_roles
    where rolname in ('anon','authenticated')
  ),
  funcs as (
    select p.oid,
           coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)) acl
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private')
      and p.prokind='f'
  ),
  actual as (
    select distinct f.oid function_oid,r.api_role
    from funcs f
    cross join roles r
    join lateral pg_catalog.aclexplode(f.acl) a
      on a.grantee=r.role_oid
     and a.privilege_type='EXECUTE'
  ),
  manifest as (
    select m.api_role,
           to_regprocedure(m.function_identity)::oid function_oid
    from private.api_permission_manifest m
    where m.api_role in ('anon','authenticated')
  )
  select
    count(*) filter(where a.api_role='anon'),
    count(*) filter(where a.api_role='authenticated'),
    (select count(*) from manifest m where m.api_role='anon'),
    (select count(*) from manifest m where m.api_role='authenticated'),
    count(*) filter(where a.api_role='anon' and not exists(
      select 1 from manifest m where m.api_role='anon' and m.function_oid=a.function_oid
    )),
    count(*) filter(where a.api_role='authenticated' and not exists(
      select 1 from manifest m where m.api_role='authenticated' and m.function_oid=a.function_oid
    )),
    (select count(*) from manifest m where m.api_role='anon' and not exists(
      select 1 from actual a where a.api_role='anon' and a.function_oid=m.function_oid
    )),
    (select count(*) from manifest m where m.api_role='authenticated' and not exists(
      select 1 from actual a where a.api_role='authenticated' and a.function_oid=m.function_oid
    ))
  into
    v_anon_actual,v_auth_actual,
    v_anon_manifest,v_auth_manifest,
    v_anon_undocumented,v_auth_undocumented,
    v_anon_missing,v_auth_missing
  from actual a;

  return jsonb_build_object(
    'anon',jsonb_build_object(
      'actual',v_anon_actual,
      'manifest',v_anon_manifest,
      'undocumented',v_anon_undocumented,
      'missing',v_anon_missing
    ),
    'authenticated',jsonb_build_object(
      'actual',v_auth_actual,
      'manifest',v_auth_manifest,
      'undocumented',v_auth_undocumented,
      'missing',v_auth_missing
    ),
    'ok',
      v_anon_undocumented=0
      and v_auth_undocumented=0
      and v_anon_missing=0
      and v_auth_missing=0
  );
end
$$;

revoke all on function private.normalize_api_permission_manifest_entry()
from public,anon,authenticated;
revoke all on function private.api_permission_manifest_report()
from public,anon,authenticated;
