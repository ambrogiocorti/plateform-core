
create or replace function public.get_public_booking_availability(
  p_venue uuid,
  p_service uuid,
  p_date date,
  p_party integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
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
     or not private.installation_active()
     or not exists(
       select 1
       from public.venue_settings
       where venue_id=p_venue
         and reservations_enabled
     )
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

    if ((p_date+make_interval(mins=>v_minute)) at time zone v_venue.timezone)<=clock_timestamp() then
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
          if not private.venue_feature_enabled(p_venue,'BOOKING_DEPOSITS') then
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
                'expiry_minutes',(v_deposit->>'expiry_minutes')::integer
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
$$;

revoke all on function public.get_public_booking_availability(uuid,uuid,date,integer)
from public;
grant execute on function public.get_public_booking_availability(uuid,uuid,date,integer)
to anon,authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_public_booking_availability(uuid,uuid,date,integer)','anon')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'PUBLIC_BOOKING_AVAILABILITY_SERVER_AUTHORITY',
  'REGRESSION',
  true,
  'Anonymous booking availability is computed server-side from service schedule, pacing, closures, large-party policy and deposit policy without exposing internal reservation counts.'
)
on conflict(key) do nothing;
