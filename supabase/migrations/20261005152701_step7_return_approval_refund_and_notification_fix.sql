create or replace function private.apply_order_correction(
  p_order uuid,
  p_version bigint,
  p_item_ids uuid[],
  p_replacements jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  o public.orders;
  a public.accounts;
  i public.order_items;
  replacement uuid;
  local_date date;
begin
  select * into o from public.orders where id=p_order;
  if o.id is null then raise exception 'NOT_FOUND'; end if;

  select * into a from public.accounts where id=o.account_id for update;
  select * into o from public.orders where id=p_order for update;

  if a.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  if o.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;

  if p_reason is null
     or length(trim(p_reason))<3
     or cardinality(p_item_ids) not between 1 and 100
     or cardinality(p_item_ids)<>(select count(distinct x) from unnest(p_item_ids) x)
     or exists(
       select 1
       from unnest(p_item_ids) x
       where not exists(
         select 1
         from public.order_items
         where id=x and order_id=o.id and status<>'CANCELLED'
       )
     )
  then
    raise exception 'INVALID_ORDER_CHANGE';
  end if;

  if exists(
    select 1
    from public.billing_units u
    where u.order_item_id=any(p_item_ids)
      and exists(
        select 1
        from public.payment_unit_allocations pa
        join public.payments p on p.id=pa.payment_id
        where pa.billing_unit_id=u.id
          and (
            (p.status='PENDING' and pa.amount_cents>0)
            or (
              p.status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')
              and private.effective_payment_allocation(pa.id)>0
            )
          )
      )
  ) then
    raise exception 'SETTLED_ITEM_REQUIRES_CORRECTION';
  end if;

  if exists(
    select 1
    from public.billing_units
    where order_item_id=any(p_item_ids)
      and account_id<>a.id
      and voided_at is null
  ) then
    raise exception 'TRANSFERRED_ITEM_REQUIRES_RECONCILIATION';
  end if;

  select (now() at time zone timezone)::date
  into local_date
  from public.venues
  where id=a.venue_id;

  perform 1
  from public.dishes
  where id in(
    select dish_id from public.order_items where id=any(p_item_ids)
    union
    select (value->>'dish_id')::uuid
    from jsonb_array_elements(coalesce(p_replacements,'[]'))
  )
  order by id
  for update;

  for i in
    select * from public.order_items
    where id=any(p_item_ids)
    order by id
    for update
  loop
    if i.status='RECEIVED' then
      update public.venue_dish_settings
      set availability=availability+i.quantity
      where venue_id=i.venue_id
        and dish_id=i.dish_id
        and availability is not null
        and availability_date=local_date;
    end if;

    update public.order_items
    set status='CANCELLED'
    where id=i.id;
  end loop;

  update public.order_steps s
  set status='CANCELLED'
  where order_id=o.id
    and not exists(
      select 1
      from public.order_items oi
      where oi.step_id=s.id
        and oi.status<>'CANCELLED'
    );

  perform private.refresh_order_status(o.id);

  if p_replacements is not null and p_replacements<>'[]'::jsonb then
    update public.accounts set status='OPEN' where id=a.id;
    replacement:=private.place_order(a.id,p_replacements,'WAITER');
  end if;

  update public.equal_split_plans
  set status='OBSOLETE',obsolete_at=now()
  where account_id=a.id and status='ACTIVE';

  perform private.refresh_account_payment_status(a.id);
  update public.accounts set updated_at=now() where id=a.id;

  perform private.audit(
    'ORDER_CORRECTED',
    'orders',
    o.id,
    o.venue_id,
    jsonb_build_object('version',o.version),
    jsonb_build_object(
      'cancelled_item_ids',p_item_ids,
      'replacement_order_id',replacement,
      'reason',p_reason
    )
  );

  return jsonb_build_object('order_id',o.id,'replacement_order_id',replacement);
end
$function$;

create or replace function public.resolve_order_change(
  p_request uuid,
  p_approve boolean,
  p_reason text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  r public.order_change_requests;
  result jsonb;
  item_ids uuid[];
begin
  select * into r
  from public.order_change_requests
  where id=p_request
  for update;

  if r.id is null then raise exception 'NOT_FOUND'; end if;

  perform private.authorize(r.venue_id,array['ADMIN']::public.user_role[]);

  result:=private.idempotency_begin(
    'resolve_order_change',
    p_key,
    jsonb_build_object(
      'request',p_request,
      'approve',p_approve,
      'reason',p_reason
    )
  );

  if result is not null then return result; end if;

  if r.status<>'PENDING' then
    return private.idempotency_finish(
      'resolve_order_change',
      p_key,
      jsonb_build_object('id',r.id,'status',r.status)
    );
  end if;

  if p_reason is null or length(trim(p_reason))<3 then
    raise exception 'REASON_REQUIRED';
  end if;

  if p_approve then
    select array_agg(x::uuid)
    into item_ids
    from jsonb_array_elements_text(r.payload->'item_ids') x;

    result:=private.apply_order_correction(
      r.order_id,
      (r.payload->>'order_version')::bigint,
      item_ids,
      coalesce(r.payload->'replacement_lines','[]'),
      p_reason
    );
  end if;

  update public.order_change_requests
  set status=case when p_approve then 'APPROVED' else 'REJECTED' end,
      resolved_by=private.effective_user_id(),
      resolved_at=now()
  where id=r.id;

  update public.notifications
  set status='RESOLVED',
      acknowledged_at=coalesce(acknowledged_at,now()),
      resolved_at=coalesce(resolved_at,now()),
      updated_at=now()
  where resource_type='order_change_requests'
    and resource_id=r.id
    and status<>'RESOLVED';

  return private.idempotency_finish(
    'resolve_order_change',
    p_key,
    coalesce(result,'{}') ||
    jsonb_build_object(
      'id',r.id,
      'status',case when p_approve then 'APPROVED' else 'REJECTED' end
    )
  );
end
$function$;

update public.notifications n
set status='RESOLVED',
    acknowledged_at=coalesce(n.acknowledged_at,now()),
    resolved_at=coalesce(n.resolved_at,now()),
    updated_at=now()
from public.order_change_requests r
where n.resource_type='order_change_requests'
  and n.resource_id=r.id
  and r.status in ('APPROVED','REJECTED')
  and n.status<>'RESOLVED';