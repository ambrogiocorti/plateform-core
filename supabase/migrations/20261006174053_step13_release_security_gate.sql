
create or replace function public.release_security_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_manifest jsonb;
  v_rls_disabled integer;
  v_private_client_grants integer;
  v_authoritative_dml integer;
  v_public_execute integer;
begin
  select private.api_permission_manifest_report() into v_manifest;

  select count(*)::integer
    into v_rls_disabled
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p')
    and n.nspname in ('public','private')
    and not c.relrowsecurity;

  select count(*)::integer
    into v_private_client_grants
  from information_schema.role_table_grants g
  where g.table_schema='private'
    and g.grantee in ('anon','authenticated');

  with critical(table_name) as (
    values
      ('payments'),
      ('refunds'),
      ('order_items'),
      ('billing_units'),
      ('payment_allocations'),
      ('payment_unit_allocations'),
      ('venue_dish_settings'),
      ('dishes'),
      ('audit_log')
  )
  select count(*)::integer
    into v_authoritative_dml
  from critical c
  cross join lateral (
    select unnest(array['INSERT','UPDATE','DELETE']) as privilege_type
  ) p
  where has_table_privilege(
    'authenticated',
    format('public.%I',c.table_name),
    p.privilege_type
  );

  select count(*)::integer
    into v_public_execute
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.prokind='f'
    and has_function_privilege('public',p.oid,'EXECUTE');

  return jsonb_build_object(
    'ok',
      v_rls_disabled=0
      and v_private_client_grants=0
      and v_authoritative_dml=0
      and coalesce((v_manifest->>'ok')::boolean,false),
    'rls_disabled_tables',v_rls_disabled,
    'private_client_table_grants',v_private_client_grants,
    'authoritative_direct_dml_grants',v_authoritative_dml,
    'permission_manifest',v_manifest,
    'public_execute_functions',v_public_execute,
    'external_manual_checks',jsonb_build_array(
      'AUTH_LEAKED_PASSWORD_PROTECTION',
      'PG_NET_PLATFORM_EXCEPTION'
    )
  );
end
$$;

revoke all on function public.release_security_gate()
from public,anon,authenticated;
grant execute on function public.release_security_gate()
to service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.release_security_gate()','service_role')
on conflict do nothing;
