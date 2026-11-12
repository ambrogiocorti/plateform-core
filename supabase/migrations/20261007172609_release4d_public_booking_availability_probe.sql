
create or replace function private.test_public_booking_availability_server_authority()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service constant uuid:='c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_regular jsonb;
  v_large jsonb;
  v_closed jsonb;
  v_full jsonb;
  v_deposit jsonb;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    update public.venue_settings
    set reservations_enabled=true
    where venue_id=v_venue;

    insert into public.service_booking_rules(
      venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,
      large_party_mode,deposit_policy,no_show_mode,no_show_grace_minutes,
      deposit_no_show_action
    ) values(
      v_venue,v_service,10,30,2,4,2,
      'REQUESTED','DISABLED','NO_SHOW_MANUAL',15,'MANUAL'
    )
    on conflict(service_id) do update
    set max_covers_service=10,
        slot_interval_minutes=30,
        max_arrivals_per_slot=2,
        max_covers_per_slot=4,
        max_party_size_auto_confirm=2,
        large_party_mode='REQUESTED',
        deposit_policy='DISABLED',
        deposit_amount_cents=null,
        deposit_percentage_bps=null,
        deposit_expiry_minutes=null,
        deposit_condition_mode='ANY',
        deposit_min_party_size=null,
        deposit_weekdays='{}'::integer[],
        deposit_dates='{}'::date[],
        deposit_start_time=null,
        deposit_end_time=null,
        updated_at=clock_timestamp();

    v_regular:=public.get_public_booking_availability(
      v_venue,v_service,date '2026-10-10',2
    );

    if jsonb_array_length(v_regular->'slots')<>2
       or not exists(
         select 1 from jsonb_array_elements(v_regular->'slots') x
         where x->>'time'='21:00'
           and (x->>'available')::boolean
           and x->>'status_if_booked'='RESERVED'
       )
    then
      raise exception 'BOOKING_AVAILABILITY_REGULAR_FAILED';
    end if;

    v_large:=public.get_public_booking_availability(
      v_venue,v_service,date '2026-10-10',3
    );

    if not exists(
      select 1 from jsonb_array_elements(v_large->'slots') x
      where x->>'time'='21:00'
        and (x->>'available')::boolean
        and x->>'status_if_booked'='REQUESTED'
    ) then
      raise exception 'BOOKING_AVAILABILITY_LARGE_PARTY_FAILED';
    end if;

    insert into public.booking_time_slots(
      venue_id,service_id,service_date,slot_time,closed,closure_reason
    ) values(
      v_venue,v_service,date '2026-10-10',time '21:30',true,'E2E'
    )
    on conflict(service_id,service_date,slot_time) do update
    set closed=true,closure_reason='E2E';

    v_closed:=public.get_public_booking_availability(
      v_venue,v_service,date '2026-10-10',2
    );

    if not exists(
      select 1 from jsonb_array_elements(v_closed->'slots') x
      where x->>'time'='21:30'
        and not (x->>'available')::boolean
        and x->>'reason'='BOOKING_CLOSED'
    ) then
      raise exception 'BOOKING_AVAILABILITY_CLOSED_FAILED';
    end if;

    insert into public.reservations(
      venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_venue,v_service,date '2026-10-10',time '21:00',
      'E2E','Capacity','+390000008001',4,'RESERVED',false
    );

    v_full:=public.get_public_booking_availability(
      v_venue,v_service,date '2026-10-10',1
    );

    if not exists(
      select 1 from jsonb_array_elements(v_full->'slots') x
      where x->>'time'='21:00'
        and not (x->>'available')::boolean
        and x->>'reason'='BOOKING_CAPACITY_REACHED'
    ) then
      raise exception 'BOOKING_AVAILABILITY_CAPACITY_FAILED';
    end if;

    update public.feature_flags
    set licensed=true
    where name='BOOKING_DEPOSITS';

    insert into public.venue_features(venue_id,name,enabled)
    values(v_venue,'BOOKING_DEPOSITS',true)
    on conflict(venue_id,name) do update
    set enabled=true,updated_at=clock_timestamp();

    update public.service_booking_rules
    set deposit_policy='REQUIRED',
        deposit_amount_cents=1000,
        deposit_percentage_bps=null,
        deposit_expiry_minutes=30,
        updated_at=clock_timestamp()
    where service_id=v_service;

    v_deposit:=public.get_public_booking_availability(
      v_venue,v_service,date '2026-10-11',2
    );

    if not exists(
      select 1 from jsonb_array_elements(v_deposit->'slots') x
      where x->>'time'='21:00'
        and (x->>'available')::boolean
        and x->>'status_if_booked'='PENDING_DEPOSIT'
        and (x->'deposit'->>'amount_cents')::bigint=1000
        and x->'deposit'->>'currency'='EUR'
        and (x->'deposit'->>'expiry_minutes')::integer=30
    ) then
      raise exception 'BOOKING_AVAILABILITY_DEPOSIT_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'regular_reserved',true,
      'large_party_requested',true,
      'closed_slot_hidden_as_unavailable',true,
      'full_slot_hidden_as_unavailable',true,
      'deposit_pending_predicted',true,
      'deposit_amount_cents',1000,
      'internal_capacity_counts_exposed',false,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_PUBLIC_BOOKING_AVAILABILITY_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_PUBLIC_BOOKING_AVAILABILITY_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_public_booking_availability_server_authority()
from public,anon,authenticated;
grant execute on function private.test_public_booking_availability_server_authority()
to service_role,postgres;
