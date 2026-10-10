create or replace function public.create_public_reservation(
  p_venue uuid,
  p_service uuid,
  p_date date,
  p_time time,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_party integer,
  p_answers jsonb,
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
  s public.services;
  rules public.service_booking_rules;
  slot public.booking_time_slots;
  day_rule public.booking_time_slots;
  total integer;
  arrivals integer;
  covers integer;
  start_minutes integer;
  selected_minutes integer;
  end_minutes integer;
  booking_status public.reservation_status;
  ref uuid;
  duplicate private.public_requests;
  digest text;
  answer record;
  form_field public.reservation_form_fields;
  result jsonb;
  deposit_decision jsonb;
  deposit_amount bigint;
  deposit_expiry_minutes integer;
  deposit_id uuid;
  deposit_token text;
  deposit_expires_at timestamptz;
begin
  if not private.check_rate_limit('booking:'||p_rate_key,10,600) then
    return jsonb_build_object('error','RATE_LIMITED');
  end if;

  if length(p_rate_key) not between 32 and 128 or p_key is null then
    raise exception 'INVALID_REQUEST';
  end if;

  digest:=encode(
    extensions.digest(
      jsonb_build_object(
        'venue',p_venue,'service',p_service,'date',p_date,'time',p_time,
        'first',p_first_name,'last',p_last_name,'phone',p_phone,
        'party',p_party,'answers',p_answers
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_advisory_xact_lock(hashtextextended('booking:'||p_key::text,0));

  select * into duplicate
  from private.public_requests
  where operation='booking' and idempotency_key=p_key;

  if found then
    if duplicate.payload_hash<>digest then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return duplicate.response;
  end if;

  select * into v
  from public.venues
  where id=p_venue and active and operational_status='OPEN';

  if v.id is null
     or not private.installation_active()
     or not exists(
       select 1 from public.venue_settings
       where venue_id=v.id and reservations_enabled
     )
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;

  select * into s
  from public.services
  where id=p_service and venue_id=v.id and active
  for update;

  select * into rules
  from public.service_booking_rules
  where service_id=s.id;

  if s.id is null or rules.service_id is null then
    raise exception 'SERVICE_UNAVAILABLE';
  end if;

  if length(trim(p_first_name)) not between 1 and 100
     or length(p_last_name)>100
     or p_phone !~ E'^\\+[0-9]{7,15}$'
     or p_party not between 1 and 1000
  then
    raise exception 'INVALID_BOOKING_DETAILS';
  end if;

  if p_date is null
     or p_date<(now() at time zone v.timezone)::date
     or p_date>(now() at time zone v.timezone)::date+180
     or not extract(isodow from p_date)::integer=any(s.weekdays)
  then
    raise exception 'BOOKING_DATE_UNAVAILABLE';
  end if;

  start_minutes:=extract(epoch from s.starts_at)::integer/60;
  end_minutes:=extract(epoch from s.ends_at)::integer/60;
  selected_minutes:=extract(epoch from p_time)::integer/60;

  if end_minutes<=start_minutes then
    end_minutes:=end_minutes+1440;
    if selected_minutes<start_minutes then selected_minutes:=selected_minutes+1440; end if;
  end if;

  if p_time is null
     or extract(second from p_time)<>0
     or selected_minutes<start_minutes
     or selected_minutes>=end_minutes
     or (selected_minutes-start_minutes)%rules.slot_interval_minutes<>0
  then
    raise exception 'BOOKING_SLOT_UNAVAILABLE';
  end if;

  if (p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone<=now() then
    raise exception 'BOOKING_IN_PAST';
  end if;

  select * into day_rule
  from public.booking_time_slots
  where service_id=s.id and service_date=p_date and slot_time is null;

  select * into slot
  from public.booking_time_slots
  where service_id=s.id and service_date=p_date and slot_time=p_time;

  if coalesce(day_rule.closed,false) or coalesce(slot.closed,false) then
    raise exception 'BOOKING_CLOSED';
  end if;

  select
    coalesce(sum(party_size),0),
    count(*) filter(where slot_time=p_time),
    coalesce(sum(party_size) filter(where slot_time=p_time),0)
  into total,arrivals,covers
  from public.reservations
  where service_id=s.id
    and service_date=p_date
    and status not in ('CANCELLED','NO_SHOW','EXPIRED');

  if total+p_party>coalesce(day_rule.max_covers_override,rules.max_covers_service)
     or arrivals+1>coalesce(slot.max_arrivals_override,rules.max_arrivals_per_slot)
     or covers+p_party>coalesce(slot.max_covers_override,rules.max_covers_per_slot)
  then
    raise exception 'BOOKING_CAPACITY_REACHED';
  end if;

  if ((p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone) at time zone v.timezone
       <>p_date+make_interval(mins=>selected_minutes)
  then
    raise exception 'NONEXISTENT_LOCAL_TIME';
  end if;

  booking_status:='RESERVED';

  if p_party>rules.max_party_size_auto_confirm then
    if rules.large_party_mode='REJECT' then
      raise exception 'CONTACT_RESTAURANT_FOR_LARGE_PARTY';
    end if;
    booking_status:='REQUESTED';
  else
    deposit_decision:=private.reservation_deposit_amount(
      s.id,p_date,p_time,p_party
    );

    if coalesce((deposit_decision->>'requires_deposit')::boolean,false) then
      if not private.venue_feature_enabled(v.id,'BOOKING_DEPOSITS') then
        raise exception 'BOOKING_DEPOSITS_DISABLED';
      end if;

      deposit_amount:=(deposit_decision->>'calculated_amount_cents')::bigint;
      deposit_expiry_minutes:=(deposit_decision->>'expiry_minutes')::integer;

      if deposit_amount is null
         or deposit_amount<=0
         or deposit_expiry_minutes is null
      then
        raise exception 'INVALID_DEPOSIT_POLICY';
      end if;

      booking_status:='PENDING_DEPOSIT';
    end if;
  end if;

  perform private.validate_booking_answers(v.id,p_answers);

  insert into public.reservations(
    venue_id,service_id,service_date,slot_time,
    first_name,last_name,phone,party_size,status
  ) values(
    v.id,s.id,p_date,p_time,
    trim(p_first_name),trim(p_last_name),p_phone,p_party,booking_status
  )
  returning id into ref;

  for answer in select key,value from jsonb_each(p_answers) loop
    select f.* into form_field
    from public.reservation_form_fields f
    join public.reservation_form_definitions d on d.id=f.form_id
    where f.id::text=answer.key
      and d.venue_id=v.id
      and d.active
      and f.visible;

    if form_field.id is null then raise exception 'UNKNOWN_FORM_FIELD'; end if;
    if answer.value='null'::jsonb and not form_field.required then continue; end if;

    insert into public.reservation_answers(
      venue_id,reservation_id,field_id,answer
    ) values(
      v.id,ref,form_field.id,answer.value
    );
  end loop;

  if booking_status='PENDING_DEPOSIT' then
    deposit_expires_at:=clock_timestamp()+make_interval(mins=>deposit_expiry_minutes);
    deposit_token:=encode(extensions.gen_random_bytes(32),'hex');

    insert into public.reservation_deposits(
      reservation_id,venue_id,amount_cents,currency,status,expires_at
    ) values(
      ref,v.id,deposit_amount,'EUR','PENDING',deposit_expires_at
    )
    returning id into deposit_id;

    insert into private.reservation_deposit_access(
      deposit_id,token_hash,expires_at
    ) values(
      deposit_id,
      private.deposit_access_token_hash(deposit_token),
      deposit_expires_at
    );

    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v.id,'HOST','RESERVATION','Caparra richiesta','reservations',ref
    );

    result:=jsonb_build_object(
      'id',ref,
      'status',booking_status,
      'deposit',jsonb_build_object(
        'id',deposit_id,
        'amount_cents',deposit_amount,
        'currency','EUR',
        'expires_at',deposit_expires_at,
        'access_token',deposit_token
      )
    );
  else
    insert into public.notifications(
      venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v.id,'HOST','RESERVATION',
      case when booking_status='REQUESTED' then 'Richiesta prenotazione' else 'Nuova prenotazione' end,
      'reservations',ref
    );

    result:=jsonb_build_object('id',ref,'status',booking_status);
  end if;

  insert into private.public_requests(
    operation,idempotency_key,payload_hash,response
  ) values(
    'booking',p_key,digest,result
  );

  return result;
end
$$;