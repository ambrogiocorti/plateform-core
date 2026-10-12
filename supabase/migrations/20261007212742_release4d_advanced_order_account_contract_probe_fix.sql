
create or replace function private.test_advanced_order_account_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_workspace_def text;
  v_return_read_def text;
  v_return_write_def text;
  v_trigger boolean;
  v_manifest boolean;
begin
  select pg_get_functiondef(p.oid)
  into v_workspace_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='get_account_workspace'
    and pg_get_function_identity_arguments(p.oid)='p_account uuid, p_before_at timestamp with time zone, p_before_id uuid, p_limit integer';

  select pg_get_functiondef(p.oid)
  into v_return_read_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='get_returnable_order_items'
    and pg_get_function_identity_arguments(p.oid)='p_venue uuid';

  select pg_get_functiondef(p.oid)
  into v_return_write_def
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname='return_order_item'
    and pg_get_function_identity_arguments(p.oid)='p_item uuid, p_action text, p_version bigint, p_key uuid';

  select exists(
    select 1
    from pg_trigger
    where tgrelid='public.order_change_requests'::regclass
      and tgname='prevent_duplicate_return_cancel_request'
      and not tgisinternal
  ) into v_trigger;

  select exists(
    select 1 from private.api_permission_manifest
    where function_identity='public.get_returnable_order_items(uuid)'
      and api_role='authenticated'
  ) into v_manifest;

  if v_workspace_def is null
     or v_workspace_def not like '%''version'',i.version%'
     or v_return_read_def is null
     or v_return_read_def not like '%pending_cancel_request%'
     or v_return_write_def is null
     or v_return_write_def not like '%RETURN_NOT_ALLOWED%'
     or v_return_write_def not like '%CANCEL_REQUEST%'
     or not v_trigger
     or not v_manifest
  then
    raise exception 'ADVANCED_ORDER_ACCOUNT_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'account_workspace_item_version',true,
    'returnable_items_authorized_rpc',true,
    'returned_item_version_exposed',true,
    'pending_cancel_request_exposed',true,
    'return_write_guard_present',true,
    'duplicate_return_cancel_guard',true,
    'permission_manifest_documented',true
  );
end
$$;
