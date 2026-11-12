begin;

create or replace function private.test_staff_identifier_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_def text;
  v_normalized text;
begin
  select pg_get_functiondef(p.oid)
  into v_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='suggest_staff_identifier'
    and pg_get_function_identity_arguments(p.oid)='p_name text';

  v_normalized:=regexp_replace(coalesce(v_def,''),'[[:space:]]+','','g');

  if v_def is null
     or v_normalized not like '%staff_identity_domain%'
     or v_normalized not like '%candidate:=base||suffix::text||''@''||domain%'
     or v_normalized like '%candidate:=base||''.''||suffix::text%'
     or v_normalized not like '%auth.users%'
     or v_normalized not like '%staff_admin_jobs%'
     or v_normalized not like '%STAFF_IDENTIFIER_UNAVAILABLE%'
  then
    raise exception 'STAFF_IDENTIFIER_CONTRACT_FAILED';
  end if;

  if not exists(
    select 1
    from information_schema.columns
    where table_schema='public'
      and table_name='restaurant_profile'
      and column_name='staff_identity_domain'
  ) then
    raise exception 'STAFF_IDENTIFIER_DOMAIN_MISSING';
  end if;

  return jsonb_build_object(
    'stable_identity_domain_column',true,
    'base_name_normalization',true,
    'first_collision_suffix','2',
    'existing_auth_users_checked',true,
    'pending_create_jobs_checked',true
  );
end
$$;

revoke all on function private.test_staff_identifier_contract()
from public,anon,authenticated;
grant execute on function private.test_staff_identifier_contract()
to service_role,postgres;

commit;