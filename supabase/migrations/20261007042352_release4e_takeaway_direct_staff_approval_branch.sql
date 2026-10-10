
create or replace function public.create_takeaway_order(
  p_venue uuid,
  p_pickup_slot uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_note text,
  p_items jsonb,
  p_key uuid,
  p_rate_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v public.venues;
  slot public.takeaway_pickup_slots;
  cfg public.venue_settings;
  v_existing private.public_requests;
  v_digest text;
  v_reserved_orders integer;
  v_reserved_items integer;
  v_effective_order_cap integer;
  v_preview jsonb;
  v_requested_items integer;
  v_subtotal bigint;
  v_account uuid;
  v_order uuid;
  v_request uuid;
  v_pickup_at timestamptz;
  v_deadline timestamptz;
  v_result jsonb;
begin
  if p_rate_key is null
     or length(p_rate_key) not between 32 and 128
     or not private.check_rate_limit('takeaway:'||p_rate_key,10,600) then
    return jsonb_build_object('error','RATE_LIMITED');
  end if;

  if p_venue is null
     or p_pickup_slot is null
     or p_key is null
     or length(trim(p_customer_name)) not between 1 and 160
     or p_customer_phone !~ E'^\\+[0-9]{7,15}$'
     or (p_customer_note is not null and length(p_customer_note)>2000)
     or jsonb_typeof(p_items)<>'array'
     or jsonb_array_length(p_items) not between 1 and 100
  then
    raise exception 'INVALID_TAKEAWAY_REQUEST';
  end if;

  perform private.takeaway_item_count(p_items);

  v_digest:=encode(extensions.digest(
    jsonb_build_object(
      'venue',p_venue,
      'pickup_slot',p_pickup_slot,
      'customer_name',trim(p_customer_name),
      'customer_phone',p_customer_phone,
      'customer_note',nullif(trim(p_customer_note),''),
      'items',p_items
    )::text,'sha256'
  ),'hex');

  perform pg_advisory_xact_lock(
    hashtextextended('takeaway:'||p_key::text,0)
  );

  select *
  into v_existing
  from private.public_requests
  where operation='takeaway_create'
    and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
  end if;

  select *
  into v
  from public.venues
  where id=p_venue
    and active
    and operational_status='OPEN';

  if v.id is null or not private.installation_active() then
    raise exception 'OPERATIONS_UNAVAILABLE';
  end if;

  if not private.venue_feature_enabled(v.id,'TAKEAWAY') then
    raise exception 'TAKEAWAY_DISABLED';
  end if;

  select *
  into cfg
  from public.venue_settings
  where venue_id=v.id;

  if cfg.venue_id is null then
    raise exception 'TAKEAWAY_SETTINGS_MISSING';
  end if;

  select *
  into slot
  from public.takeaway_pickup_slots
  where id=p_pickup_slot
    and venue_id=v.id
  for update;

  if slot.id is null then raise exception 'TAKEAWAY_SLOT_NOT_FOUND'; end if;
  if slot.closed then raise exception 'TAKEAWAY_SLOT_CLOSED'; end if;

  v_pickup_at:=(slot.pickup_date+slot.pickup_time) at time zone v.timezone;

  if slot.pickup_date<(clock_timestamp() at time zone v.timezone)::date
     or slot.pickup_date>
       (clock_timestamp() at time zone v.timezone)::date
       + cfg.takeaway_advance_order_limit_days
  then
    raise exception 'TAKEAWAY_SLOT_DATE_OUT_OF_RANGE';
  end if;

  if v_pickup_at
     < clock_timestamp()
       + make_interval(mins=>cfg.takeaway_preparation_buffer_minutes)
  then
    raise exception 'TAKEAWAY_PREPARATION_BUFFER';
  end if;

  if extract(second from slot.pickup_time)<>0
     or mod(
       extract(hour from slot.pickup_time)::integer*60
       + extract(minute from slot.pickup_time)::integer,
       cfg.takeaway_slot_interval_minutes
     )<>0
  then
    raise exception 'TAKEAWAY_SLOT_INTERVAL_MISMATCH';
  end if;

  v_effective_order_cap:=least(
    slot.capacity_orders,
    coalesce(cfg.takeaway_max_orders_per_slot,slot.capacity_orders)
  );

  v_reserved_orders:=private.takeaway_slot_reserved_orders(slot.id);
  if v_reserved_orders>=v_effective_order_cap then
    raise exception 'TAKEAWAY_SLOT_FULL' using errcode='40001';
  end if;

  v_preview:=private.takeaway_request_preview(
    v.id,slot.pickup_date,p_items
  );
  v_requested_items:=(v_preview->>'item_count')::integer;
  v_subtotal:=(v_preview->>'subtotal_cents')::bigint;

  if cfg.takeaway_max_items_per_slot is not null then
    v_reserved_items:=private.takeaway_slot_reserved_items(slot.id);
    if v_reserved_items+v_requested_items>
       cfg.takeaway_max_items_per_slot then
      raise exception 'TAKEAWAY_SLOT_ITEM_LIMIT' using errcode='40001';
    end if;
  end if;

  if cfg.takeaway_minimum_order_cents is not null
     and v_subtotal<cfg.takeaway_minimum_order_cents then
    raise exception 'TAKEAWAY_MINIMUM_ORDER';
  end if;

  if cfg.takeaway_order_mode='STAFF_APPROVAL' then
    v_deadline:=
      v_pickup_at
      - make_interval(mins=>cfg.takeaway_preparation_buffer_minutes);

    insert into public.takeaway_requests(
      venue_id,pickup_slot_id,pickup_at,
      customer_name,customer_phone,customer_note,items,
      status,decision_deadline
    ) values(
      v.id,slot.id,v_pickup_at,
      trim(p_customer_name),p_customer_phone,nullif(trim(p_customer_note),''),
      p_items,
      'PENDING_CONFIRMATION',v_deadline
    )
    returning id into v_request;

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values
      (
        v.id,'PASS','NEW_ORDER',
        'Richiesta takeaway da approvare',
        'takeaway_requests',v_request
      ),
      (
        v.id,'ADMIN','NEW_ORDER',
        'Richiesta takeaway da approvare',
        'takeaway_requests',v_request
      );

    v_result:=jsonb_build_object(
      'request_id',v_request,
      'status','PENDING_CONFIRMATION',
      'mode','STAFF_APPROVAL',
      'pickup_slot_id',slot.id,
      'pickup_at',v_pickup_at,
      'item_count',v_requested_items,
      'subtotal_cents',v_subtotal,
      'payment_modes_allowed',to_jsonb(cfg.takeaway_payment_modes_allowed)
    );
  else
    insert into public.accounts(
      venue_id,table_id,account_name,covers,status,created_by,
      financial_partition,account_type,internal_note
    ) values(
      v.id,null,trim(p_customer_name),0,'OPEN',null,
      false,'TAKEAWAY',nullif(trim(p_customer_note),'')
    )
    returning id into v_account;

    v_order:=private.place_order(v_account,p_items,'TAKEAWAY');

    insert into public.takeaway_orders(
      order_id,venue_id,account_id,pickup_slot_id,pickup_at,
      customer_name,customer_phone,customer_note,status
    ) values(
      v_order,v.id,v_account,slot.id,v_pickup_at,
      trim(p_customer_name),p_customer_phone,
      nullif(trim(p_customer_note),''),
      'PLACED'
    );

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v.id,'PASS','NEW_ORDER',
      'Nuovo ordine takeaway','orders',v_order
    );

    v_result:=jsonb_build_object(
      'order_id',v_order,
      'account_id',v_account,
      'status','PLACED',
      'mode','DIRECT',
      'pickup_slot_id',slot.id,
      'pickup_at',v_pickup_at,
      'item_count',v_requested_items,
      'subtotal_cents',v_subtotal,
      'payment_modes_allowed',to_jsonb(cfg.takeaway_payment_modes_allowed)
    );
  end if;

  insert into private.public_requests(
    operation,idempotency_key,payload_hash,response
  ) values(
    'takeaway_create',p_key,v_digest,v_result
  );

  return v_result;
end
$$;
