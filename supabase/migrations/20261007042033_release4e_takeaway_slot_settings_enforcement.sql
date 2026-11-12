
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
  v_settings public.venue_settings;
  v_timezone text;
  v_local_today date;
  v_pickup_at timestamptz;
  v_minute_of_day integer;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if not private.venue_feature_enabled(p_venue,'TAKEAWAY') then
    raise exception 'TAKEAWAY_DISABLED';
  end if;

  select *
  into v_settings
  from public.venue_settings
  where venue_id=p_venue;

  select timezone
  into v_timezone
  from public.venues
  where id=p_venue and active;

  if v_settings.venue_id is null or v_timezone is null then
    raise exception 'NOT_FOUND';
  end if;

  if p_key is null
     or p_date is null
     or p_time is null
     or p_capacity_orders not between 1 and 1000
     or p_closed is null
  then
    raise exception 'INVALID_TAKEAWAY_SLOT';
  end if;

  v_local_today:=(clock_timestamp() at time zone v_timezone)::date;
  v_pickup_at:=(p_date+p_time) at time zone v_timezone;
  v_minute_of_day:=
    extract(hour from p_time)::integer*60
    + extract(minute from p_time)::integer;

  if extract(second from p_time)<>0
     or mod(v_minute_of_day,v_settings.takeaway_slot_interval_minutes)<>0
  then
    raise exception 'TAKEAWAY_SLOT_INTERVAL_MISMATCH';
  end if;

  if p_date<v_local_today
     or p_date>v_local_today+v_settings.takeaway_advance_order_limit_days
  then
    raise exception 'TAKEAWAY_SLOT_DATE_OUT_OF_RANGE';
  end if;

  if v_pickup_at
     < clock_timestamp()
       + make_interval(mins=>v_settings.takeaway_preparation_buffer_minutes)
  then
    raise exception 'TAKEAWAY_PREPARATION_BUFFER';
  end if;

  if v_settings.takeaway_max_orders_per_slot is not null
     and p_capacity_orders>v_settings.takeaway_max_orders_per_slot
  then
    raise exception 'TAKEAWAY_SLOT_CAPACITY_LIMIT';
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
    if v_row.venue_id<>p_venue then
      raise exception 'VENUE_FORBIDDEN' using errcode='42501';
    end if;
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
    'id',v_row.id,
    'venue_id',v_row.venue_id,
    'pickup_date',v_row.pickup_date,
    'pickup_time',v_row.pickup_time,
    'capacity_orders',v_row.capacity_orders,
    'closed',v_row.closed,
    'version',v_row.version
  );

  return private.idempotency_finish('takeaway_pickup_slot',p_key,v_result);
end
$$;
