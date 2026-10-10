-- Plateform P0: reconstitute two business RPCs found in live Development but absent from the 457 canonical migration bodies.
-- Deliberately do NOT version private.debug_menu_experience_e2e or public.continuity_rehearsal_export_chunk:
-- these are test/rehearsal-specific privileged routines, not general customer functions.
-- Idempotence: this CREATE OR REPLACE preserves historical signature and business authorization.

CREATE OR REPLACE FUNCTION public.get_account_transfer_targets(p_account uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_account public.accounts;
begin
  select * into v_account
  from public.accounts
  where id=p_account;

  if v_account.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(v_account.venue_id,array['ADMIN','CASHIER']::public.user_role[],false);

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',a.id,
        'account_name',a.account_name,
        'table_id',a.table_id,
        'table_name',t.name,
        'status',a.status,
        'version',a.version,
        'covers',a.covers
      )
      order by t.name,a.account_name,a.id
    )
    from public.accounts a
    left join public.tables t on t.id=a.table_id
    where a.venue_id=v_account.venue_id
      and a.id<>v_account.id
      and a.status<>'CLOSED'
      and a.floor_released_at is null
      and a.table_id=any(private.table_group(v_account.table_id))
      and private.can_read_account(a.id)
  ),'[]'::jsonb);
end
$function$
;

CREATE OR REPLACE FUNCTION public.get_order_change_center(p_venue uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',r.id,
        'order_id',r.order_id,
        'account_id',o.account_id,
        'account_name',a.account_name,
        'table_name',t.name,
        'requested_by',r.requested_by,
        'requested_by_name',sp.display_name,
        'kind',r.kind,
        'payload',r.payload,
        'reason',r.reason,
        'status',r.status,
        'created_at',r.created_at,
        'current_order_version',o.version,
        'items',coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id',i.id,
              'dish_name',i.dish_name,
              'quantity',i.quantity,
              'status',i.status
            )
            order by i.created_at,i.id
          )
          from public.order_items i
          where i.order_id=o.id
            and i.id in (
              select value::uuid
              from jsonb_array_elements_text(coalesce(r.payload->'item_ids','[]'::jsonb))
            )
        ),'[]'::jsonb)
      )
      order by r.created_at,r.id
    )
    from public.order_change_requests r
    join public.orders o on o.id=r.order_id
    join public.accounts a on a.id=o.account_id
    left join public.tables t on t.id=a.table_id
    left join public.staff_profiles sp on sp.id=r.requested_by
    where r.venue_id=p_venue
      and r.status='PENDING'
  ),'[]'::jsonb);
end
$function$
;

REVOKE ALL ON FUNCTION public.get_account_transfer_targets(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_order_change_center(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_transfer_targets(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_change_center(uuid) TO authenticated, service_role;

INSERT INTO private.api_permission_manifest(function_identity, api_role) VALUES
  ('public.get_account_transfer_targets(uuid)', 'authenticated'),
  ('public.get_order_change_center(uuid)', 'authenticated')
ON CONFLICT DO NOTHING;

DO $permission_gate$
BEGIN
  IF has_function_privilege('anon', 'public.get_account_transfer_targets(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_change_center(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_account_transfer_targets(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.get_order_change_center(uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_account_transfer_targets(uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.get_order_change_center(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'OPERATIONAL_RPC_PERMISSION_PARITY_FAILED';
  END IF;
END $permission_gate$;
