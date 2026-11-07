
create or replace function public.approve_takeaway_order(
  p_request uuid,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_req public.takeaway_requests;
  v_slot public.takeaway_pickup_slots;
  v_cfg public.venue_settings;
  v_actor uuid;
  v_result jsonb;
  v_preview jsonb;
  v_account uuid;
  v_order uuid;
  v_order_cap integer;
begin
  if p_request is null or p_version is null or p_key is null then
    raise exception 'INVALID_TAKEAWAY_APPROVAL';
  end if;

  select * into v_req
  from public.takeaway_requests
  where id=p_request;

  if v_req.id is null then raise exception 'NOT_FOUND'; end if;

  v_actor:=private.authorize(
    v_req.venue_id,
    array['ADMIN','PASS']::public.user_role[]
  );

  if not private.venue_feature_enabled(v_req.venue_id,'TAKEAWAY') then
    raise exception 'TAKEAWAY_DISABLED';
  end if;

  v_result:=private.idempotency_begin(
    'takeaway_approve',
    p_key,
    jsonb_build_object(
      'request',p_request,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  select * into v_req
  from public.takeaway_requests
  where id=p_request
  for update;

  if v_req.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  if v_req.status='CONFIRMED' and v_req.order_id is not null then
    v_result:=jsonb_build_object(
      'request_id',v_req.id,
      'order_id',v_req.order_id,
      'status','CONFIRMED',
      'version',v_req.version
    );
    return private.idempotency_finish('takeaway_approve',p_key,v_result);
  end if;

  if v_req.status<>'PENDING_CONFIRMATION' then
    raise exception 'TAKEAWAY_REQUEST_NOT_PENDING';
  end if;

  if v_req.decision_deadline<=clock_timestamp() then
    update public.takeaway_requests
    set status='EXPIRED',
        decided_at=clock_timestamp()
    where id=v_req.id;
    raise exception 'TAKEAWAY_REQUEST_EXPIRED';
  end if;

  select * into v_slot
  from public.takeaway_pickup_slots
  where id=v_req.pickup_slot_id
    and venue_id=v_req.venue_id
  for update;

  if v_slot.id is null then raise exception 'TAKEAWAY_SLOT_NOT_FOUND'; end if;
  if v_slot.closed then raise exception 'TAKEAWAY_SLOT_CLOSED'; end if;

  select * into v_cfg
  from public.venue_settings
  where venue_id=v_req.venue_id;

  if v_cfg.takeaway_order_mode<>'STAFF_APPROVAL' then
    raise exception 'TAKEAWAY_APPROVAL_MODE_DISABLED';
  end if;

  v_order_cap:=least(
    v_slot.capacity_orders,
    coalesce(v_cfg.takeaway_max_orders_per_slot,v_slot.capacity_orders)
  );

  if private.takeaway_slot_reserved_orders(v_slot.id)>v_order_cap then
    raise exception 'TAKEAWAY_SLOT_FULL' using errcode='40001';
  end if;

  if v_cfg.takeaway_max_items_per_slot is not null
     and private.takeaway_slot_reserved_items(v_slot.id)>
       v_cfg.takeaway_max_items_per_slot
  then
    raise exception 'TAKEAWAY_SLOT_ITEM_LIMIT' using errcode='40001';
  end if;

  v_preview:=private.takeaway_request_preview(
    v_req.venue_id,
    (v_req.pickup_at at time zone (
      select timezone from public.venues where id=v_req.venue_id
    ))::date,
    v_req.items
  );

  if v_cfg.takeaway_minimum_order_cents is not null
     and (v_preview->>'subtotal_cents')::bigint<
       v_cfg.takeaway_minimum_order_cents
  then
    raise exception 'TAKEAWAY_MINIMUM_ORDER';
  end if;

  insert into public.accounts(
    venue_id,table_id,account_name,covers,status,created_by,
    financial_partition,account_type,internal_note
  ) values(
    v_req.venue_id,null,v_req.customer_name,0,'OPEN',v_actor,
    false,'TAKEAWAY',v_req.customer_note
  )
  returning id into v_account;

  v_order:=private.place_order(v_account,v_req.items,'TAKEAWAY');

  insert into public.takeaway_orders(
    order_id,venue_id,account_id,pickup_slot_id,pickup_at,
    customer_name,customer_phone,customer_note,status
  ) values(
    v_order,v_req.venue_id,v_account,v_req.pickup_slot_id,v_req.pickup_at,
    v_req.customer_name,v_req.customer_phone,v_req.customer_note,'PLACED'
  );

  update public.takeaway_requests
  set status='CONFIRMED',
      order_id=v_order,
      decided_by=v_actor,
      decided_at=clock_timestamp(),
      rejection_reason=null
  where id=v_req.id
  returning * into v_req;

  insert into public.notifications(
    venue_id,recipient_role,category,title,resource_type,resource_id
  ) values(
    v_req.venue_id,'PASS','NEW_ORDER',
    'Takeaway approvato — inviare in preparazione',
    'orders',v_order
  );

  v_result:=jsonb_build_object(
    'request_id',v_req.id,
    'order_id',v_order,
    'account_id',v_account,
    'status','CONFIRMED',
    'order_status','PLACED',
    'version',v_req.version,
    'pickup_at',v_req.pickup_at
  );

  return private.idempotency_finish('takeaway_approve',p_key,v_result);
end
$$;

create or replace function public.reject_takeaway_order(
  p_request uuid,
  p_version bigint,
  p_reason text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_req public.takeaway_requests;
  v_actor uuid;
  v_result jsonb;
begin
  if p_request is null
     or p_version is null
     or p_key is null
     or (p_reason is not null and length(trim(p_reason)) not between 1 and 500)
  then
    raise exception 'INVALID_TAKEAWAY_REJECTION';
  end if;

  select * into v_req
  from public.takeaway_requests
  where id=p_request;

  if v_req.id is null then raise exception 'NOT_FOUND'; end if;

  v_actor:=private.authorize(
    v_req.venue_id,
    array['ADMIN','PASS']::public.user_role[]
  );

  v_result:=private.idempotency_begin(
    'takeaway_reject',
    p_key,
    jsonb_build_object(
      'request',p_request,
      'version',p_version,
      'reason',nullif(trim(p_reason),'')
    )
  );
  if v_result is not null then return v_result; end if;

  select * into v_req
  from public.takeaway_requests
  where id=p_request
  for update;

  if v_req.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  if v_req.status='REJECTED' then
    v_result:=jsonb_build_object(
      'request_id',v_req.id,
      'status','REJECTED',
      'version',v_req.version
    );
    return private.idempotency_finish('takeaway_reject',p_key,v_result);
  end if;

  if v_req.status<>'PENDING_CONFIRMATION' then
    raise exception 'TAKEAWAY_REQUEST_NOT_PENDING';
  end if;

  update public.takeaway_requests
  set status='REJECTED',
      decided_by=v_actor,
      decided_at=clock_timestamp(),
      rejection_reason=nullif(trim(p_reason),'')
  where id=v_req.id
  returning * into v_req;

  v_result:=jsonb_build_object(
    'request_id',v_req.id,
    'status','REJECTED',
    'version',v_req.version
  );

  return private.idempotency_finish('takeaway_reject',p_key,v_result);
end
$$;

create or replace function public.run_takeaway_request_expiry(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_count integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 5000 then
    raise exception 'INVALID_LIMIT';
  end if;

  with due as (
    select id
    from public.takeaway_requests
    where status='PENDING_CONFIRMATION'
      and decision_deadline<=clock_timestamp()
    order by decision_deadline,id
    for update skip locked
    limit p_limit
  ),
  changed as (
    update public.takeaway_requests r
    set status='EXPIRED',
        decided_at=clock_timestamp()
    from due
    where r.id=due.id
    returning r.id
  )
  select count(*)::integer into v_count
  from changed;

  return jsonb_build_object('expired',v_count);
end
$$;

revoke all on function public.approve_takeaway_order(uuid,bigint,uuid)
from public,anon;
grant execute on function public.approve_takeaway_order(uuid,bigint,uuid)
to authenticated,service_role;

revoke all on function public.reject_takeaway_order(uuid,bigint,text,uuid)
from public,anon;
grant execute on function public.reject_takeaway_order(uuid,bigint,text,uuid)
to authenticated,service_role;

revoke all on function public.run_takeaway_request_expiry(integer)
from public,anon,authenticated;
grant execute on function public.run_takeaway_request_expiry(integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.approve_takeaway_order(uuid,bigint,uuid)','authenticated'),
  ('public.reject_takeaway_order(uuid,bigint,text,uuid)','authenticated'),
  ('public.run_takeaway_request_expiry(integer)','service_role')
on conflict do nothing;

select cron.schedule(
  'plateform-takeaway-request-expiry',
  '* * * * *',
  'select public.run_takeaway_request_expiry(500);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-takeaway-request-expiry'
);
