begin;
create function public.request_order_change(p_order uuid,p_kind text,p_payload jsonb,p_reason text,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; a public.accounts; ref uuid; previous jsonb;
begin
  select * into o from public.orders where id=p_order;
  if o.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(o.venue_id,array['WAITER']::public.user_role[]);
  select * into a from public.accounts where id=o.account_id;
  if private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED'; end if;
  previous:=private.idempotency_begin('order_change_request',p_key,jsonb_build_object('order',p_order,'kind',p_kind,'payload',p_payload,'reason',p_reason,'version',p_version));
  if previous is not null then return previous; end if;
  if p_kind is null or p_kind not in ('MODIFICATION','CANCELLATION') or p_reason is null or length(trim(p_reason))<3
    or p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload-array['item_ids','replacement_lines']<>'{}'::jsonb then raise exception 'INVALID_ORDER_CHANGE'; end if;
  if o.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  insert into public.order_change_requests(venue_id,order_id,requested_by,kind,payload,reason)
    values(o.venue_id,o.id,private.effective_user_id(),p_kind,p_payload||jsonb_build_object('order_version',o.version),trim(p_reason)) returning id into ref;
  insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id)
    values(o.venue_id,'ADMIN','ORDER_CHANGE','Modifica comanda da autorizzare','order_change_requests',ref);
  return private.idempotency_finish('order_change_request',p_key,jsonb_build_object('id',ref,'status','PENDING'));
end $$;
grant execute on function public.request_order_change(uuid,text,jsonb,text,bigint,uuid) to authenticated;

create function private.apply_order_correction(p_order uuid,p_version bigint,p_item_ids uuid[],p_replacements jsonb,p_reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; a public.accounts; i public.order_items; replacement uuid; local_date date;
begin
  select * into o from public.orders where id=p_order;
  if o.id is null then raise exception 'NOT_FOUND'; end if;
  -- Account -> order -> dishes is the lock order used by create_order/finance.
  select * into a from public.accounts where id=o.account_id for update;
  select * into o from public.orders where id=p_order for update;
  if a.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  if o.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_reason is null or length(trim(p_reason))<3 or cardinality(p_item_ids) not between 1 and 100
    or cardinality(p_item_ids)<>(select count(distinct x) from unnest(p_item_ids) x)
    or exists(select 1 from unnest(p_item_ids) x where not exists(select 1 from public.order_items where id=x and order_id=o.id and status<>'CANCELLED')) then raise exception 'INVALID_ORDER_CHANGE'; end if;
  if exists(select 1 from public.billing_units u join public.payment_unit_allocations pa on pa.billing_unit_id=u.id join public.payments p on p.id=pa.payment_id
    where u.order_item_id=any(p_item_ids) and p.status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) then raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION'; end if;
  if exists(select 1 from public.billing_units where order_item_id=any(p_item_ids) and account_id<>a.id and voided_at is null) then raise exception 'TRANSFERRED_ITEM_REQUIRES_RECONCILIATION'; end if;
  select (now() at time zone timezone)::date into local_date from public.venues where id=a.venue_id;
  perform 1 from public.dishes where id in(select dish_id from public.order_items where id=any(p_item_ids) union select (value->>'dish_id')::uuid from jsonb_array_elements(coalesce(p_replacements,'[]'))) order by id for update;
  for i in select * from public.order_items where id=any(p_item_ids) order by id for update loop
    -- Only unstarted food returns to today's available portions. Prepared food is waste.
    if i.status='RECEIVED' then update public.venue_dish_settings set availability=availability+i.quantity where venue_id=i.venue_id and dish_id=i.dish_id and availability is not null and availability_date=local_date; end if;
    update public.order_items set status='CANCELLED' where id=i.id;
  end loop;
  update public.order_steps s set status='CANCELLED' where order_id=o.id and not exists(select 1 from public.order_items oi where oi.step_id=s.id and oi.status<>'CANCELLED');
  perform private.refresh_order_status(o.id);
  if p_replacements is not null and p_replacements<>'[]'::jsonb then
    update public.accounts set status='OPEN' where id=a.id;
    replacement:=private.place_order(a.id,p_replacements,'WAITER');
  end if;
  update public.equal_split_plans set status='OBSOLETE',obsolete_at=now() where account_id=a.id and status='ACTIVE';
  perform private.refresh_account_payment_status(a.id);
  update public.accounts set updated_at=now() where id=a.id;
  perform private.audit('ORDER_CORRECTED','orders',o.id,o.venue_id,jsonb_build_object('version',o.version),jsonb_build_object('cancelled_item_ids',p_item_ids,'replacement_order_id',replacement,'reason',p_reason));
  return jsonb_build_object('order_id',o.id,'replacement_order_id',replacement);
end $$;
create function public.modify_order(p_order uuid,p_version bigint,p_item_ids uuid[],p_replacements jsonb,p_reason text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; venue uuid;
begin
  select venue_id into venue from public.orders where id=p_order;
  if venue is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('modify_order',p_key,jsonb_build_object('order',p_order,'version',p_version,'items',p_item_ids,'replacements',p_replacements,'reason',p_reason));
  if result is not null then return result; end if;
  return private.idempotency_finish('modify_order',p_key,private.apply_order_correction(p_order,p_version,p_item_ids,p_replacements,p_reason));
end $$;
grant execute on function public.modify_order(uuid,bigint,uuid[],jsonb,text,uuid) to authenticated;

create function public.resolve_order_change(p_request uuid,p_approve boolean,p_reason text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.order_change_requests; result jsonb; item_ids uuid[];
begin
  select * into r from public.order_change_requests where id=p_request for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('resolve_order_change',p_key,jsonb_build_object('request',p_request,'approve',p_approve,'reason',p_reason));
  if result is not null then return result; end if;
  if r.status<>'PENDING' then return private.idempotency_finish('resolve_order_change',p_key,jsonb_build_object('id',r.id,'status',r.status)); end if;
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'REASON_REQUIRED'; end if;
  if p_approve then
    select array_agg(x::uuid) into item_ids from jsonb_array_elements_text(r.payload->'item_ids') x;
    result:=private.apply_order_correction(r.order_id,(r.payload->>'order_version')::bigint,item_ids,coalesce(r.payload->'replacement_lines','[]'),p_reason);
  end if;
  update public.order_change_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,resolved_by=private.effective_user_id(),resolved_at=now() where id=r.id;
  return private.idempotency_finish('resolve_order_change',p_key,coalesce(result,'{}')||jsonb_build_object('id',r.id,'status',case when p_approve then 'APPROVED' else 'REJECTED' end));
end $$;
grant execute on function public.resolve_order_change(uuid,boolean,text,uuid) to authenticated;

create function public.return_order_item(p_item uuid,p_action text,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.order_items; a public.accounts; ref uuid; request_ref uuid; result jsonb;
begin
  select * into i from public.order_items where id=p_item;
  if i.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(i.venue_id,array['PASS','KITCHEN_ADMIN']::public.user_role[]);
  select a0.* into a from public.accounts a0 join public.orders o on o.account_id=a0.id where o.id=i.order_id for update of a0;
  perform 1 from public.orders where id=i.order_id for update;
  select * into i from public.order_items where id=i.id for update;
  result:=private.idempotency_begin('return_item',p_key,jsonb_build_object('item',p_item,'action',p_action,'version',p_version));
  if result is not null then return result; end if;
  if i.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if a.floor_released_at is not null or i.status not in ('READY','SERVED') or not exists(select 1 from public.venue_settings where venue_id=i.venue_id and returns_enabled)
    or p_action is null or p_action not in ('REMAKE','CANCEL_REQUEST') then raise exception 'RETURN_NOT_ALLOWED'; end if;
  insert into public.returned_items(venue_id,order_item_id,action) values(i.venue_id,i.id,p_action) returning id into ref;
  if p_action='REMAKE' then
    perform 1 from public.dishes where id=i.dish_id for update;
    if exists(select 1 from public.venue_dish_settings where venue_id=i.venue_id and dish_id=i.dish_id and availability is not null and (availability<i.quantity or availability_date is distinct from (now() at time zone (select timezone from public.venues where id=i.venue_id))::date)) then raise exception 'OUT_OF_STOCK'; end if;
    update public.venue_dish_settings set availability=availability-i.quantity where venue_id=i.venue_id and dish_id=i.dish_id and availability is not null;
    update public.order_items set status='RECEIVED',started_at=null,ready_at=null,served_at=null where id=i.id;
    update public.order_steps set status='ACTIVE',ready_at=null,served_at=null where id=i.step_id;
    delete from public.step_deliveries where step_id=i.step_id;
    perform private.refresh_order_status(i.order_id);
  else
    insert into public.order_change_requests(venue_id,order_id,requested_by,kind,payload,reason)
      values(i.venue_id,i.order_id,private.effective_user_id(),'RETURN_CANCELLATION',jsonb_build_object('item_ids',jsonb_build_array(i.id),'order_version',(select version from public.orders where id=i.order_id)),'ERRORE ORDINE') returning id into request_ref;
    insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id) values(i.venue_id,'ADMIN','RETURN_APPROVAL','Annullamento piatto reso da autorizzare','order_change_requests',request_ref);
  end if;
  perform private.audit('ITEM_RETURNED','order_items',i.id,i.venue_id,null,jsonb_build_object('action',p_action));
  return private.idempotency_finish('return_item',p_key,jsonb_build_object('id',ref,'request_id',request_ref));
end $$;
grant execute on function public.return_order_item(uuid,text,bigint,uuid) to authenticated;
commit;
