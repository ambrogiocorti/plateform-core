create or replace function public.save_takeaway_pickup_slot(
  p_id uuid,
  p_venue uuid,
  p_date date,
  p_time time,
  p_capacity_orders integer,
  p_closed boolean,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_row public.takeaway_pickup_slots;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if not private.venue_feature_enabled(p_venue,'TAKEAWAY') then
    raise exception 'TAKEAWAY_DISABLED';
  end if;

  if p_key is null
     or p_date is null
     or p_time is null
     or p_capacity_orders not between 1 and 1000
     or p_closed is null
  then
    raise exception 'INVALID_TAKEAWAY_SLOT';
  end if;

  v_result:=private.idempotency_begin(
    'takeaway_pickup_slot',p_key,
    jsonb_build_object(
      'id',p_id,'venue',p_venue,'date',p_date,'time',p_time,
      'capacity_orders',p_capacity_orders,'closed',p_closed,'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.takeaway_pickup_slots(
      id,venue_id,pickup_date,pickup_time,capacity_orders,closed
    ) values(
      v_id,p_venue,p_date,p_time,p_capacity_orders,p_closed
    )
    returning * into v_row;
  else
    select * into v_row
    from public.takeaway_pickup_slots
    where id=p_id
    for update;

    if v_row.id is null then raise exception 'NOT_FOUND'; end if;
    if v_row.venue_id<>p_venue then raise exception 'VENUE_FORBIDDEN' using errcode='42501'; end if;
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.takeaway_pickup_slots
    set pickup_date=p_date,
        pickup_time=p_time,
        capacity_orders=p_capacity_orders,
        closed=p_closed
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,'venue_id',v_row.venue_id,
    'pickup_date',v_row.pickup_date,'pickup_time',v_row.pickup_time,
    'capacity_orders',v_row.capacity_orders,'closed',v_row.closed,
    'version',v_row.version
  );

  return private.idempotency_finish('takeaway_pickup_slot',p_key,v_result);
end
$$;

revoke all on function public.save_takeaway_pickup_slot(uuid,uuid,date,time,integer,boolean,bigint,uuid)
from public,anon;
grant execute on function public.save_takeaway_pickup_slot(uuid,uuid,date,time,integer,boolean,bigint,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.save_takeaway_pickup_slot(uuid,uuid,date,time without time zone,integer,boolean,bigint,uuid)','authenticated')
on conflict do nothing;