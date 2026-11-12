-- Online booking deposit for large groups (owner decision, Ambrogio, 2026-10-21):
-- "se è un gruppo numeroso, paga una quota decisa dall'admin di sede solo per 'assicurazione'".
--
-- The deposit is a guarantee, never a prepayment of the bill:
--   * only groups of at least the venue admin's threshold pay it (deposit_policy CONDITIONAL with
--     deposit_min_party_size, amount in deposit_amount_cents, set by configure_large_group_deposit);
--   * the server alone decides it (booking_deposit_policy_decision, unchanged) and fails closed
--     without the BOOKING_DEPOSITS licence, the venue feature and at least one licensed provider
--     (Stripe or Satispay) offered by the venue;
--   * it is refunded automatically once the reservation is honoured (SEATED/COMPLETED) or cancelled
--     before the venue's window (deposit_cancel_refund_hours); a later cancellation goes to the
--     admin (MANUAL_REQUIRED); a no-show retains it (deposit_no_show_action RETAIN, existing queue).
-- Refunds reuse the verified provider queue of 20261007121404/20261007121613 and its worker.
-- BOOKING_DEPOSITS may now be licensed, but only while STRIPE or SATISPAY_API is licensed.
-- The Epson/print guards of 20261008181605 are untouched.

-- Licensing ------------------------------------------------------------------------------------

create or replace function private.core_edition_license_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if new.name='BOOKING_DEPOSITS' and new.licensed
     and not (private.feature_licensed('STRIPE') or private.feature_licensed('SATISPAY_API')) then
    raise exception 'BOOKING_DEPOSITS_PROVIDER_LICENCE_REQUIRED';
  end if;
  return new;
end $core$;
revoke all on function private.core_edition_license_guard() from public,anon,authenticated;

-- A provider licence cannot be revoked while it is the last one deposits rely on, and the deposit
-- licence cannot be revoked while guests are paying or refunds are still owed.
create or replace function private.booking_deposit_licence_revocation_guard()
returns trigger language plpgsql security definer set search_path='' as $core$
begin
  if not (old.licensed and not new.licensed) then
    return new;
  end if;
  if new.name in ('STRIPE','SATISPAY_API')
     and private.feature_licensed('BOOKING_DEPOSITS')
     and not private.feature_licensed(case new.name when 'STRIPE' then 'SATISPAY_API' else 'STRIPE' end)
  then
    raise exception 'BOOKING_DEPOSITS_STILL_LICENSED';
  end if;
  if new.name='BOOKING_DEPOSITS' and (
       exists(select 1 from public.reservation_deposits where status='PENDING')
       or exists(select 1 from private.reservation_deposit_no_show_actions
                 where state in ('QUEUED','IN_FLIGHT','WAITING'))
     )
  then
    raise exception 'BOOKING_DEPOSITS_PENDING';
  end if;
  return new;
end $core$;
revoke all on function private.booking_deposit_licence_revocation_guard() from public,anon,authenticated;
create trigger booking_deposit_licence_revocation before update of licensed on public.feature_flags
for each row execute function private.booking_deposit_licence_revocation_guard();

-- Providers a venue can take deposits with: installation licence plus the venue offering the
-- method (its keys are per-venue Edge Function secrets, see docs/STEP6_PROVIDER_CONFIGURATION.md).
create or replace function private.booking_deposit_providers(p_venue uuid)
returns text[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(p.provider order by p.provider),'{}'::text[])
  from (values ('STRIPE','STRIPE'),('SATISPAY','SATISPAY_API')) as p(provider,method)
  where private.feature_licensed(p.method)
    and exists(
      select 1 from public.venue_settings vs
      where vs.venue_id=p_venue and p.method=any(vs.payment_methods::text[])
    )
$$;
revoke all on function private.booking_deposit_providers(uuid) from public,anon,authenticated;

create or replace function private.booking_deposits_ready(p_venue uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.venue_feature_enabled(p_venue,'BOOKING_DEPOSITS')
    and cardinality(private.booking_deposit_providers(p_venue))>0
$$;
revoke all on function private.booking_deposits_ready(uuid) from public,anon,authenticated;

-- Admin rule and release queue columns ----------------------------------------------------------

alter table public.service_booking_rules
  add column if not exists deposit_cancel_refund_hours integer not null default 24;
alter table public.service_booking_rules
  add constraint service_booking_rules_deposit_cancel_refund_hours_check
  check(deposit_cancel_refund_hours between 0 and 720);

-- The no-show queue becomes the deposit release queue: NO_SHOW (existing), HONOURED, CANCELLED.
alter table private.reservation_deposit_no_show_actions
  add column if not exists reason text not null default 'NO_SHOW';
alter table private.reservation_deposit_no_show_actions
  add constraint reservation_deposit_no_show_actions_reason_check
  check(reason in ('NO_SHOW','HONOURED','CANCELLED'));
create unique index if not exists reservation_deposit_release_once_idx
on private.reservation_deposit_no_show_actions(deposit_id)
where reason in ('HONOURED','CANCELLED');

-- Public booking: the deposit gate is now licence + venue feature + provider ------------------
-- Re-declared from the live definitions (20261007034935 + 20261008102214 for the reservation,
-- 20261011135611 for availability, 20261007035127 for the checkout start); only the deposit gate
-- and the list of payable providers change.

CREATE OR REPLACE FUNCTION public.create_public_reservation(p_venue uuid, p_service uuid, p_date date, p_time time without time zone, p_first_name text, p_last_name text, p_phone text, p_party integer, p_answers jsonb, p_key uuid, p_rate_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or not private.public_booking_ready(p_venue)
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
      if not private.booking_deposits_ready(v.id) then
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
        'access_token',deposit_token,
        'providers',to_jsonb(private.booking_deposit_providers(v.id))
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
$function$;

CREATE OR REPLACE FUNCTION public.get_public_booking_availability(p_venue uuid, p_service uuid, p_date date, p_party integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_venue public.venues;
  v_service public.services;
  v_rules public.service_booking_rules;
  v_start integer;
  v_end integer;
  v_minute integer;
  v_time time;
  v_capacity jsonb;
  v_deposit jsonb;
  v_slots jsonb:='[]'::jsonb;
  v_available boolean;
  v_reason text;
  v_status text;
begin
  if p_venue is null
     or p_service is null
     or p_date is null
     or p_party is null
     or p_party not between 1 and 1000
  then
    raise exception 'INVALID_REQUEST';
  end if;

  select *
  into v_venue
  from public.venues
  where id=p_venue
    and active
    and operational_status='OPEN';

  if v_venue.id is null
     or not private.public_booking_ready(p_venue)
  then
    raise exception 'RESERVATIONS_DISABLED';
  end if;

  select *
  into v_service
  from public.services
  where id=p_service
    and venue_id=p_venue
    and active;

  select *
  into v_rules
  from public.service_booking_rules
  where service_id=p_service
    and venue_id=p_venue;

  if v_service.id is null or v_rules.service_id is null then
    raise exception 'SERVICE_UNAVAILABLE';
  end if;

  if p_date<(clock_timestamp() at time zone v_venue.timezone)::date
     or p_date>(clock_timestamp() at time zone v_venue.timezone)::date+180
     or not extract(isodow from p_date)::integer=any(v_service.weekdays)
  then
    return jsonb_build_object(
      'venue_id',p_venue,
      'service_id',p_service,
      'date',p_date,
      'party_size',p_party,
      'slots','[]'::jsonb
    );
  end if;

  v_start:=extract(epoch from v_service.starts_at)::integer/60;
  v_end:=extract(epoch from v_service.ends_at)::integer/60;
  if v_end<=v_start then
    v_end:=v_end+1440;
  end if;

  v_minute:=v_start;
  while v_minute<v_end loop
    v_time:=(time '00:00'+make_interval(mins=>mod(v_minute,1440)))::time;
    v_capacity:=private.booking_capacity_snapshot(p_service,p_date,v_time);
    v_available:=
      coalesce((v_capacity->>'available')::boolean,false)
      and coalesce((v_capacity->>'available_covers')::integer,0)>=p_party
      and coalesce((v_capacity->>'available_arrivals')::integer,0)>=1;
    v_reason:=null;
    v_status:='RESERVED';
    v_deposit:=null;

    -- A local clock time skipped by DST must never be advertised as bookable.
    -- Round-trip the local timestamp through the venue timezone, matching
    -- create_public_reservation's NONEXISTENT_LOCAL_TIME validation.
    if (((p_date + make_interval(mins=>v_minute)) at time zone v_venue.timezone)
        at time zone v_venue.timezone)
          <> (p_date + make_interval(mins=>v_minute)) then
      v_available:=false;
      v_reason:='NONEXISTENT_LOCAL_TIME';
    elsif ((p_date+make_interval(mins=>v_minute)) at time zone v_venue.timezone)<=clock_timestamp() then
      v_available:=false;
      v_reason:='BOOKING_IN_PAST';
    elsif coalesce((v_capacity->>'closed')::boolean,false) then
      v_available:=false;
      v_reason:='BOOKING_CLOSED';
    elsif not v_available then
      v_reason:='BOOKING_CAPACITY_REACHED';
    elsif p_party>v_rules.max_party_size_auto_confirm then
      if v_rules.large_party_mode='REJECT' then
        v_available:=false;
        v_reason:='CONTACT_RESTAURANT_FOR_LARGE_PARTY';
      else
        v_status:='REQUESTED';
      end if;
    else
      begin
        v_deposit:=private.reservation_deposit_amount(
          p_service,p_date,v_time,p_party
        );

        if coalesce((v_deposit->>'requires_deposit')::boolean,false) then
          if not private.booking_deposits_ready(p_venue) then
            v_available:=false;
            v_reason:='BOOKING_DEPOSITS_DISABLED';
          else
            v_status:='PENDING_DEPOSIT';
          end if;
        else
          v_deposit:=null;
        end if;
      exception
        when others then
          v_available:=false;
          v_reason:='BOOKING_CONFIGURATION_ERROR';
          v_deposit:=null;
      end;
    end if;

    v_slots:=v_slots||jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'time',to_char(v_time,'HH24:MI'),
          'available',v_available,
          'reason',v_reason,
          'status_if_booked',case when v_available then v_status else null end,
          'deposit',case
            when v_available and v_status='PENDING_DEPOSIT' then
              jsonb_build_object(
                'amount_cents',(v_deposit->>'calculated_amount_cents')::bigint,
                'currency','EUR',
                'expiry_minutes',(v_deposit->>'expiry_minutes')::integer,
                'providers',to_jsonb(private.booking_deposit_providers(p_venue))
              )
            else null
          end
        )
      )
    );

    v_minute:=v_minute+v_rules.slot_interval_minutes;
  end loop;

  return jsonb_build_object(
    'venue_id',p_venue,
    'service_id',p_service,
    'date',p_date,
    'party_size',p_party,
    'slots',v_slots
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.begin_reservation_deposit(p_deposit uuid, p_access_token text, p_provider text, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_provider text:=upper(trim(p_provider));
  v_deposit public.reservation_deposits;
  v_result jsonb;
  v_existing private.public_requests;
  v_payload jsonb;
  v_digest text;
begin
  if p_deposit is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
     or v_provider not in ('STRIPE','SATISPAY')
     or p_key is null
  then
    raise exception 'INVALID_DEPOSIT_START';
  end if;

  if not private.verify_reservation_deposit_access(p_deposit,p_access_token) then
    raise exception 'DEPOSIT_ACCESS_DENIED' using errcode='42501';
  end if;

  v_payload:=jsonb_build_object(
    'deposit',p_deposit,
    'token_hash',private.deposit_access_token_hash(p_access_token),
    'provider',v_provider
  );
  v_digest:=encode(extensions.digest(v_payload::text,'sha256'),'hex');

  perform pg_advisory_xact_lock(
    hashtextextended('reservation_deposit_start:'||p_key::text,0)
  );

  select * into v_existing
  from private.public_requests
  where operation='reservation_deposit_start'
    and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
  end if;

  select * into v_deposit
  from public.reservation_deposits
  where id=p_deposit
  for update;

  if v_deposit.id is null then raise exception 'NOT_FOUND'; end if;
  if v_deposit.status<>'PENDING' then raise exception 'DEPOSIT_NOT_PENDING'; end if;
  if v_deposit.expires_at<=clock_timestamp() then raise exception 'DEPOSIT_EXPIRED'; end if;
  if not private.booking_deposits_ready(v_deposit.venue_id) then
    raise exception 'BOOKING_DEPOSITS_DISABLED';
  end if;
  if not v_provider=any(private.booking_deposit_providers(v_deposit.venue_id)) then
    raise exception 'DEPOSIT_PROVIDER_UNAVAILABLE';
  end if;

  if v_deposit.provider is not null and v_deposit.provider<>v_provider then
    raise exception 'DEPOSIT_PROVIDER_ALREADY_SELECTED';
  end if;

  if v_deposit.provider is null then
    update public.reservation_deposits
    set provider=v_provider
    where id=v_deposit.id
    returning * into v_deposit;
  end if;

  v_result:=jsonb_build_object(
    'deposit_id',v_deposit.id,
    'reservation_id',v_deposit.reservation_id,
    'venue_id',v_deposit.venue_id,
    'amount_cents',v_deposit.amount_cents,
    'currency',v_deposit.currency,
    'provider',v_deposit.provider,
    'expires_at',v_deposit.expires_at
  );

  insert into private.public_requests(
    operation,idempotency_key,payload_hash,response
  ) values(
    'reservation_deposit_start',p_key,v_digest,v_result
  );

  return v_result;
end
$function$;


-- Guest status and provider lookups (service_role, used by the reservation-deposit function) ----

-- The guest keeps the access token returned once by create_public_reservation; it still reads the
-- outcome after the payment revoked the token for new checkouts (30 days at most).
create or replace function public.get_reservation_deposit_status(
  p_deposit uuid,
  p_access_token text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  d public.reservation_deposits;
  r public.reservations;
  v public.venues;
begin
  if p_deposit is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
  then
    raise exception 'INVALID_DEPOSIT_STATUS_REQUEST';
  end if;

  select dep.* into d
  from public.reservation_deposits dep
  join private.reservation_deposit_access a on a.deposit_id=dep.id
  where dep.id=p_deposit
    and a.token_hash=private.deposit_access_token_hash(p_access_token)
    and dep.created_at>clock_timestamp()-interval '30 days';

  if d.id is null then
    raise exception 'DEPOSIT_ACCESS_DENIED' using errcode='42501';
  end if;

  select * into r from public.reservations where id=d.reservation_id;
  select * into v from public.venues where id=d.venue_id;

  return jsonb_build_object(
    'deposit_id',d.id,
    'reservation_id',r.id,
    'venue_id',d.venue_id,
    'venue_slug',v.slug,
    'deposit_status',d.status,
    'reservation_status',r.status,
    'provider',d.provider,
    'provider_reference',d.provider_reference,
    'amount_cents',d.amount_cents,
    'refunded_amount_cents',d.refunded_amount_cents,
    'currency',d.currency,
    'expires_at',d.expires_at,
    'providers',to_jsonb(private.booking_deposit_providers(d.venue_id)),
    'service_date',r.service_date,
    'slot_time',to_char(r.slot_time,'HH24:MI'),
    'party_size',r.party_size
  );
end
$$;

-- Webhook / callback lookup by deposit id: no guest token, only what a provider re-read needs.
create or replace function public.get_reservation_deposit_for_provider(p_deposit uuid)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'deposit_id',d.id,
    'reservation_id',d.reservation_id,
    'venue_id',d.venue_id,
    'venue_slug',v.slug,
    'deposit_status',d.status,
    'provider',d.provider,
    'provider_reference',d.provider_reference,
    'amount_cents',d.amount_cents,
    'currency',d.currency,
    'expires_at',d.expires_at
  )
  from public.reservation_deposits d
  join public.venues v on v.id=d.venue_id
  where d.id=p_deposit
$$;

-- A verified provider payment that the deposit state machine can no longer accept (it expired
-- first): never silently kept, the admin must refund or reinstate it.
create or replace function public.record_reservation_deposit_late_payment(
  p_deposit uuid,
  p_provider text,
  p_provider_reference text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  d public.reservation_deposits;
begin
  select * into d
  from public.reservation_deposits
  where id=p_deposit
    and provider=upper(trim(p_provider))
    and provider_reference=trim(p_provider_reference);

  if d.id is null then raise exception 'DEPOSIT_NOT_FOUND'; end if;

  if not exists(
    select 1 from public.notifications n
    where n.resource_type='reservation_deposits'
      and n.resource_id=d.id
      and n.category='DEPOSIT_REFUND_RECONCILIATION'
  ) then
    insert into public.notifications(
      venue_id,recipient_role,category,priority,title,resource_type,resource_id
    ) values(
      d.venue_id,'ADMIN','DEPOSIT_REFUND_RECONCILIATION','WARNING',
      'Caparra pagata dopo la scadenza: rimborso da verificare',
      'reservation_deposits',d.id
    );

    perform private.audit(
      'RESERVATION_DEPOSIT_LATE_PAYMENT',
      'reservation_deposits',
      d.id,
      d.venue_id,
      null,
      jsonb_build_object(
        'reservation_id',d.reservation_id,
        'provider',d.provider,
        'status',d.status,
        'amount_cents',d.amount_cents
      )
    );
  end if;

  return jsonb_build_object('deposit_id',d.id,'deposit_status',d.status,'reconciliation',true);
end
$$;

revoke all on function public.get_reservation_deposit_status(uuid,text) from public,anon,authenticated;
revoke all on function public.get_reservation_deposit_for_provider(uuid) from public,anon,authenticated;
revoke all on function public.record_reservation_deposit_late_payment(uuid,text,text) from public,anon,authenticated;
grant execute on function public.get_reservation_deposit_status(uuid,text) to service_role,postgres;
grant execute on function public.get_reservation_deposit_for_provider(uuid) to service_role,postgres;
grant execute on function public.record_reservation_deposit_late_payment(uuid,text,text) to service_role,postgres;

-- Release on an honoured or cancelled reservation ------------------------------------------------

create or replace function private.enqueue_reservation_deposit_release(p_reservation uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_res public.reservations;
  v_rule public.service_booking_rules;
  v_dep public.reservation_deposits;
  v_action private.reservation_deposit_no_show_actions;
  v_reason text;
  v_policy text:='REFUND_FULL';
  v_requested bigint;
  v_state text;
  v_error text;
  v_starts timestamptz;
  v_timezone text;
begin
  select * into v_res from public.reservations where id=p_reservation;

  if v_res.id is null or v_res.status not in ('SEATED','COMPLETED','CANCELLED') then
    return null;
  end if;

  select * into v_dep
  from public.reservation_deposits
  where reservation_id=v_res.id
    and status in ('COMPLETED','PARTIALLY_REFUNDED')
  order by created_at desc,id desc
  limit 1;

  if v_dep.id is null then
    return null;
  end if;

  select * into v_action
  from private.reservation_deposit_no_show_actions
  where deposit_id=v_dep.id and reason in ('HONOURED','CANCELLED');

  if v_action.id is not null then
    return jsonb_build_object('id',v_action.id,'reason',v_action.reason,'state',v_action.state);
  end if;

  if v_res.status in ('SEATED','COMPLETED') then
    v_reason:='HONOURED';
  else
    v_reason:='CANCELLED';
    select * into v_rule
    from public.service_booking_rules
    where service_id=v_res.service_id and venue_id=v_res.venue_id;
    select timezone into v_timezone from public.venues where id=v_res.venue_id;
    v_starts:=(v_res.service_date+coalesce(v_res.slot_time,time '00:00'))
      at time zone coalesce(v_timezone,'Europe/Rome');
    if clock_timestamp()>v_starts
         -make_interval(hours=>coalesce(v_rule.deposit_cancel_refund_hours,24)) then
      -- Outside the venue's window: the guarantee is neither kept nor returned automatically.
      v_policy:='MANUAL';
      v_error:='LATE_CANCELLATION';
    end if;
  end if;

  v_requested:=greatest(v_dep.amount_cents-v_dep.refunded_amount_cents,0);
  v_state:=case
    when v_policy='MANUAL' then 'MANUAL_REQUIRED'
    when v_requested=0 then 'COMPLETED'
    when v_dep.provider is null or v_dep.provider_reference is null then 'MANUAL_REQUIRED'
    else 'QUEUED'
  end;
  if v_state='MANUAL_REQUIRED' and v_error is null then
    v_error:='PROVIDER_REFERENCE_MISSING';
  end if;

  insert into private.reservation_deposit_no_show_actions(
    deposit_id,reservation_id,venue_id,reservation_version,reason,
    policy,refund_bps,target_refund_cents,requested_refund_cents,
    provider,provider_payment_id,state,last_error_code,completed_at
  ) values(
    v_dep.id,v_res.id,v_res.venue_id,v_res.version,v_reason,
    v_policy,null,
    case when v_policy='MANUAL' then 0 else v_dep.amount_cents end,
    case when v_policy='MANUAL' then 0 else v_requested end,
    v_dep.provider,v_dep.provider_reference,v_state,v_error,
    case when v_state='COMPLETED' then clock_timestamp() end
  )
  on conflict do nothing
  returning * into v_action;

  if v_action.id is null then
    select * into v_action
    from private.reservation_deposit_no_show_actions
    where deposit_id=v_dep.id and reason in ('HONOURED','CANCELLED');
    return jsonb_build_object('id',v_action.id,'reason',v_action.reason,'state',v_action.state);
  end if;

  if v_action.state='MANUAL_REQUIRED' then
    insert into public.notifications(
      venue_id,recipient_role,category,priority,title,resource_type,resource_id
    ) values(
      v_res.venue_id,'ADMIN','DEPOSIT_RELEASE_ACTION_REQUIRED','WARNING',
      case when v_error='LATE_CANCELLATION'
        then 'Cancellazione tardiva: decidi se rimborsare la caparra'
        else 'Rimborso della caparra da eseguire manualmente' end,
      'reservation_deposit_no_show_actions',v_action.id
    );
  end if;

  perform private.audit(
    'RESERVATION_DEPOSIT_RELEASE_POLICY',
    'reservation_deposit_no_show_actions',
    v_action.id,
    v_action.venue_id,
    null,
    jsonb_build_object(
      'reservation_id',v_action.reservation_id,
      'deposit_id',v_action.deposit_id,
      'reason',v_action.reason,
      'policy',v_action.policy,
      'state',v_action.state,
      'requested_refund_cents',v_action.requested_refund_cents
    )
  );

  return jsonb_build_object(
    'id',v_action.id,
    'reason',v_action.reason,
    'policy',v_action.policy,
    'state',v_action.state,
    'requested_refund_cents',v_action.requested_refund_cents
  );
end
$$;
revoke all on function private.enqueue_reservation_deposit_release(uuid) from public,anon,authenticated;

create or replace function private.reservation_deposit_release_trigger()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.status is distinct from new.status
     and new.status in ('SEATED','COMPLETED','CANCELLED') then
    perform private.enqueue_reservation_deposit_release(new.id);
  end if;
  return new;
end
$$;
revoke all on function private.reservation_deposit_release_trigger() from public,anon,authenticated;

create trigger reservation_deposit_release
after update of status on public.reservations
for each row
execute function private.reservation_deposit_release_trigger();

-- Venue admin: the large-group rule ------------------------------------------------------------

create or replace function public.configure_large_group_deposit(
  p_venue uuid,
  p_service uuid,
  p_version bigint,
  p_enabled boolean,
  p_min_party_size integer,
  p_amount_cents bigint,
  p_cancel_refund_hours integer,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_row public.service_booking_rules;
  v_old public.service_booking_rules;
  v_result jsonb;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if p_key is null
     or p_service is null
     or p_enabled is null
     or p_cancel_refund_hours is null
     or p_cancel_refund_hours not between 0 and 720
     or (
       p_enabled and (
         p_min_party_size is null
         or p_min_party_size not between 2 and 1000
         or p_amount_cents is null
         or p_amount_cents not between 100 and 100000
       )
     )
  then
    raise exception 'INVALID_LARGE_GROUP_DEPOSIT';
  end if;

  perform 1
  from public.services
  where id=p_service and venue_id=p_venue and active
  for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_row
  from public.service_booking_rules
  where service_id=p_service and venue_id=p_venue
  for update;

  if v_row.service_id is null then raise exception 'BOOKING_RULES_NOT_FOUND'; end if;
  if p_version is null or v_row.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  v_result:=private.idempotency_begin(
    'large_group_deposit',
    p_key,
    jsonb_build_object(
      'venue',p_venue,
      'service',p_service,
      'version',p_version,
      'enabled',p_enabled,
      'min_party_size',p_min_party_size,
      'amount_cents',p_amount_cents,
      'cancel_refund_hours',p_cancel_refund_hours
    )
  );
  if v_result is not null then return v_result; end if;

  v_old:=v_row;

  if p_enabled then
    if not private.feature_licensed('BOOKING_DEPOSITS') then
      raise exception 'FEATURE_NOT_LICENSED';
    end if;
    if cardinality(private.booking_deposit_providers(p_venue))=0 then
      raise exception 'DEPOSIT_PROVIDER_UNAVAILABLE';
    end if;
    -- Bigger groups need the host's approval first (REQUESTED); a threshold above the
    -- automatic confirmation limit would never ask for the guarantee.
    if p_min_party_size>v_row.max_party_size_auto_confirm then
      raise exception 'DEPOSIT_THRESHOLD_ABOVE_AUTO_CONFIRM';
    end if;

    insert into public.venue_features(venue_id,name,enabled)
    values(p_venue,'BOOKING_DEPOSITS',true)
    on conflict(venue_id,name) do update set enabled=true
    where not public.venue_features.enabled;

    update public.service_booking_rules
    set deposit_policy='CONDITIONAL',
        deposit_amount_cents=p_amount_cents,
        deposit_percentage_bps=null,
        deposit_expiry_minutes=45,
        deposit_condition_mode='ALL',
        deposit_min_party_size=p_min_party_size,
        deposit_weekdays='{}'::integer[],
        deposit_dates='{}'::date[],
        deposit_start_time=null,
        deposit_end_time=null,
        deposit_no_show_action='RETAIN',
        deposit_no_show_refund_bps=null,
        deposit_cancel_refund_hours=p_cancel_refund_hours
    where service_id=p_service
    returning * into v_row;
  else
    update public.service_booking_rules
    set deposit_policy='DISABLED',
        deposit_amount_cents=null,
        deposit_percentage_bps=null,
        deposit_expiry_minutes=null,
        deposit_condition_mode='ANY',
        deposit_min_party_size=null,
        deposit_weekdays='{}'::integer[],
        deposit_dates='{}'::date[],
        deposit_start_time=null,
        deposit_end_time=null,
        deposit_cancel_refund_hours=p_cancel_refund_hours
    where service_id=p_service
    returning * into v_row;

    if not exists(
      select 1 from public.service_booking_rules
      where venue_id=p_venue and deposit_policy<>'DISABLED'
    ) then
      update public.venue_features
      set enabled=false
      where venue_id=p_venue and name='BOOKING_DEPOSITS' and enabled;
    end if;
  end if;

  perform private.audit(
    'LARGE_GROUP_DEPOSIT_CONFIGURED',
    'service_booking_rules',
    p_service,
    p_venue,
    jsonb_build_object(
      'deposit_policy',v_old.deposit_policy,
      'amount_cents',v_old.deposit_amount_cents,
      'min_party_size',v_old.deposit_min_party_size,
      'cancel_refund_hours',v_old.deposit_cancel_refund_hours
    ),
    jsonb_build_object(
      'deposit_policy',v_row.deposit_policy,
      'amount_cents',v_row.deposit_amount_cents,
      'min_party_size',v_row.deposit_min_party_size,
      'cancel_refund_hours',v_row.deposit_cancel_refund_hours
    )
  );

  v_result:=jsonb_build_object(
    'service_id',v_row.service_id,
    'version',v_row.version,
    'enabled',v_row.deposit_policy='CONDITIONAL',
    'min_party_size',v_row.deposit_min_party_size,
    'amount_cents',v_row.deposit_amount_cents,
    'cancel_refund_hours',v_row.deposit_cancel_refund_hours
  );

  return private.idempotency_finish('large_group_deposit',p_key,v_result);
end
$$;

create or replace function public.get_large_group_deposit_settings(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);

  return jsonb_build_object(
    'venue_id',p_venue,
    'licensed',private.feature_licensed('BOOKING_DEPOSITS'),
    'venue_enabled',private.venue_feature_enabled(p_venue,'BOOKING_DEPOSITS'),
    'providers',to_jsonb(private.booking_deposit_providers(p_venue)),
    'ready',private.booking_deposits_ready(p_venue),
    'services',coalesce((
      select jsonb_agg(jsonb_build_object(
        'service_id',s.id,
        'name',s.name,
        'version',r.version,
        'enabled',r.deposit_policy='CONDITIONAL' and r.deposit_min_party_size is not null,
        'deposit_policy',r.deposit_policy,
        'min_party_size',r.deposit_min_party_size,
        'amount_cents',r.deposit_amount_cents,
        'cancel_refund_hours',r.deposit_cancel_refund_hours,
        'max_party_size_auto_confirm',r.max_party_size_auto_confirm
      ) order by s.starts_at,s.name)
      from public.services s
      join public.service_booking_rules r on r.service_id=s.id
      where s.venue_id=p_venue and s.active
    ),'[]'::jsonb)
  );
end
$$;

revoke all on function public.configure_large_group_deposit(uuid,uuid,bigint,boolean,integer,bigint,integer,uuid) from public,anon;
revoke all on function public.get_large_group_deposit_settings(uuid) from public,anon;
grant execute on function public.configure_large_group_deposit(uuid,uuid,bigint,boolean,integer,bigint,integer,uuid) to authenticated,service_role;
grant execute on function public.get_large_group_deposit_settings(uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_reservation_deposit_status(uuid,text)','service_role'),
  ('public.get_reservation_deposit_for_provider(uuid)','service_role'),
  ('public.record_reservation_deposit_late_payment(uuid,text,text)','service_role'),
  ('public.configure_large_group_deposit(uuid,uuid,bigint,boolean,integer,bigint,integer,uuid)','authenticated'),
  ('public.get_large_group_deposit_settings(uuid)','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'LARGE_GROUP_BOOKING_DEPOSIT',
  'REGRESSION',
  true,
  'Groups at or above the admin threshold get PENDING_DEPOSIT only with the BOOKING_DEPOSITS licence, the venue feature and a licensed provider offered by the venue; a verified provider result confirms the booking; SEATED/COMPLETED or a timely cancellation queue a full refund, a late cancellation goes to the admin and a no-show retains the guarantee.'
)
on conflict(key) do nothing;
