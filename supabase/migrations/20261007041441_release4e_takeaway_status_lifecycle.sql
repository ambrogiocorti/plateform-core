
create or replace function public.update_takeaway_status(
  p_order uuid,
  p_status text,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tw public.takeaway_orders;
  v_order public.orders;
  v_status text:=upper(trim(p_status));
  v_actor uuid;
  v_result jsonb;
begin
  if p_order is null
     or v_status not in ('IN_PREPARATION','READY_FOR_PICKUP','COLLECTED')
     or p_version is null
     or p_key is null
  then
    raise exception 'INVALID_TAKEAWAY_STATUS_REQUEST';
  end if;

  select * into v_tw
  from public.takeaway_orders
  where order_id=p_order;

  if v_tw.order_id is null then raise exception 'NOT_FOUND'; end if;

  if not private.venue_feature_enabled(v_tw.venue_id,'TAKEAWAY') then
    raise exception 'TAKEAWAY_DISABLED';
  end if;

  if v_status='COLLECTED' then
    v_actor:=private.authorize(
      v_tw.venue_id,
      array['ADMIN','PASS']::public.user_role[]
    );
  else
    v_actor:=private.authorize(
      v_tw.venue_id,
      array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]
    );
  end if;

  v_result:=private.idempotency_begin(
    'takeaway_status',
    p_key,
    jsonb_build_object(
      'order',p_order,
      'status',v_status,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  perform 1
  from public.orders
  where id=p_order
  for update;

  select * into v_tw
  from public.takeaway_orders
  where order_id=p_order
  for update;

  select * into v_order
  from public.orders
  where id=p_order;

  if v_tw.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  if v_status='IN_PREPARATION' then
    if v_tw.status<>'PLACED' then
      raise exception 'INVALID_TAKEAWAY_TRANSITION';
    end if;

    if v_order.status<>'IN_PREPARATION' then
      raise exception 'TAKEAWAY_KITCHEN_NOT_STARTED';
    end if;

    update public.takeaway_orders
    set status='IN_PREPARATION'
    where order_id=p_order
    returning * into v_tw;

  elsif v_status='READY_FOR_PICKUP' then
    if v_tw.status not in ('PLACED','IN_PREPARATION') then
      raise exception 'INVALID_TAKEAWAY_TRANSITION';
    end if;

    if v_order.status<>'READY' then
      raise exception 'TAKEAWAY_NOT_READY';
    end if;

    if not exists(
      select 1
      from public.order_items
      where order_id=p_order
        and status<>'CANCELLED'
    ) or exists(
      select 1
      from public.order_items
      where order_id=p_order
        and status not in ('READY','SERVED','CANCELLED')
    ) then
      raise exception 'TAKEAWAY_NOT_READY';
    end if;

    update public.takeaway_orders
    set status='READY_FOR_PICKUP',
        ready_at=coalesce(ready_at,clock_timestamp())
    where order_id=p_order
    returning * into v_tw;

  else
    if v_tw.status<>'READY_FOR_PICKUP' then
      raise exception 'INVALID_TAKEAWAY_TRANSITION';
    end if;

    update public.order_items
    set status='SERVED',
        served_at=coalesce(served_at,clock_timestamp())
    where order_id=p_order
      and status='READY';

    update public.order_steps
    set status='SERVED',
        served_at=coalesce(served_at,clock_timestamp())
    where order_id=p_order
      and status<>'CANCELLED';

    perform private.refresh_order_status(p_order);

    update public.takeaway_orders
    set status='COLLECTED',
        collected_at=coalesce(collected_at,clock_timestamp())
    where order_id=p_order
    returning * into v_tw;
  end if;

  select * into v_order
  from public.orders
  where id=p_order;

  v_result:=jsonb_build_object(
    'order_id',v_tw.order_id,
    'takeaway_status',v_tw.status,
    'order_status',v_order.status,
    'version',v_tw.version,
    'ready_at',v_tw.ready_at,
    'collected_at',v_tw.collected_at
  );

  return private.idempotency_finish('takeaway_status',p_key,v_result);
end
$$;

revoke all on function public.update_takeaway_status(uuid,text,bigint,uuid)
from public,anon;

grant execute on function public.update_takeaway_status(uuid,text,bigint,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.update_takeaway_status(uuid,text,bigint,uuid)',
  'authenticated'
)
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'TAKEAWAY_STATUS_LIFECYCLE',
  'REGRESSION',
  true,
  'Takeaway operational status follows kitchen truth: preparation requires started items, ready requires all active items READY/SERVED, and collection serves items/steps and removes the ticket from active KDS.'
)
on conflict(key) do nothing;
