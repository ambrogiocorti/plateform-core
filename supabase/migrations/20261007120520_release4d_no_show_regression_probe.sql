
create or replace function private.test_reservation_no_show_grace_period()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_venue uuid;
  v_service uuid;
  v_timezone text;
  v_now timestamptz:=clock_timestamp();
  v_local_now timestamp;
  v_auto_local timestamp;
  v_suggest_local timestamp;
  v_manual_local timestamp;
  v_auto uuid:=gen_random_uuid();
  v_suggest uuid:=gen_random_uuid();
  v_manual uuid:=gen_random_uuid();
  v_before jsonb;
  v_after jsonb;
  v_suggest_result jsonb;
  v_manual_result jsonb;
  v_status text;
  v_auto_status text;
  v_suggest_status text;
  v_manual_status text;
  v_auto_audit integer;
  v_auto_notification integer;
  v_suggest_notification integer;
  v_manual_notification integer;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    select v.id,s.id,v.timezone
    into v_venue,v_service,v_timezone
    from public.venues v
    join public.services s
      on s.venue_id=v.id
     and s.active
    where v.active
      and v.operational_status='OPEN'
    order by v.id,s.id
    limit 1;

    if v_venue is null or v_service is null or v_timezone is null then
      raise exception 'NO_SHOW_TEST_FIXTURE_UNAVAILABLE';
    end if;

    v_local_now:=v_now at time zone v_timezone;
    v_auto_local:=v_local_now-interval '10 minutes';
    v_suggest_local:=v_local_now-interval '20 minutes';
    v_manual_local:=v_local_now-interval '25 minutes';

    insert into public.service_booking_rules(
      venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,
      max_party_size_auto_confirm,large_party_mode,
      deposit_policy,no_show_mode,no_show_grace_minutes,
      deposit_no_show_action
    ) values(
      v_venue,v_service,100,5,100,100,8,'REQUESTED',
      'DISABLED','NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD',15,'MANUAL'
    )
    on conflict(service_id) do update
    set no_show_mode='NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD',
        no_show_grace_minutes=15,
        deposit_no_show_action='MANUAL',
        deposit_no_show_refund_bps=null,
        updated_at=clock_timestamp();

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_auto,v_venue,v_service,v_auto_local::date,v_auto_local::time,
      'NoShow','Auto','+390000001001',2,'RESERVED',false
    );

    v_before:=public.run_reservation_no_show_scheduler(v_now,100);

    select status::text into v_status
    from public.reservations
    where id=v_auto;

    if v_status<>'RESERVED'
       or coalesce((v_before->>'marked_no_show')::integer,0)<>0
    then
      raise exception 'NO_SHOW_BEFORE_GRACE_FAILED';
    end if;

    v_after:=public.run_reservation_no_show_scheduler(
      v_now+interval '6 minutes',
      100
    );

    select status::text into v_auto_status
    from public.reservations
    where id=v_auto;

    select count(*)::integer into v_auto_audit
    from public.audit_log
    where resource_type='reservations'
      and resource_id=v_auto
      and action='RESERVATION_NO_SHOW_AUTOMATIC';

    select count(*)::integer into v_auto_notification
    from public.notifications
    where resource_type='reservations'
      and resource_id=v_auto
      and category='NO_SHOW_AUTOMATIC';

    if v_auto_status<>'NO_SHOW'
       or coalesce((v_after->>'marked_no_show')::integer,0)<>1
       or v_auto_audit<1
       or v_auto_notification<>1
    then
      raise exception 'NO_SHOW_AFTER_GRACE_FAILED';
    end if;

    update public.service_booking_rules
    set no_show_mode='NO_SHOW_SUGGESTED',
        no_show_grace_minutes=15
    where service_id=v_service;

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_suggest,v_venue,v_service,v_suggest_local::date,v_suggest_local::time,
      'NoShow','Suggested','+390000001002',2,'RESERVED',false
    );

    v_suggest_result:=public.run_reservation_no_show_scheduler(v_now,100);
    perform public.run_reservation_no_show_scheduler(v_now,100);

    select status::text into v_suggest_status
    from public.reservations
    where id=v_suggest;

    select count(*)::integer into v_suggest_notification
    from public.notifications
    where resource_type='reservations'
      and resource_id=v_suggest
      and category='NO_SHOW_SUGGESTION';

    if v_suggest_status<>'RESERVED'
       or coalesce((v_suggest_result->>'suggested')::integer,0)<>1
       or v_suggest_notification<>1
    then
      raise exception 'NO_SHOW_SUGGESTED_FAILED';
    end if;

    update public.service_booking_rules
    set no_show_mode='NO_SHOW_MANUAL',
        no_show_grace_minutes=15
    where service_id=v_service;

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_manual,v_venue,v_service,v_manual_local::date,v_manual_local::time,
      'NoShow','Manual','+390000001003',2,'RESERVED',false
    );

    v_manual_result:=public.run_reservation_no_show_scheduler(v_now,100);

    select status::text into v_manual_status
    from public.reservations
    where id=v_manual;

    select count(*)::integer into v_manual_notification
    from public.notifications
    where resource_type='reservations'
      and resource_id=v_manual
      and category in ('NO_SHOW_AUTOMATIC','NO_SHOW_SUGGESTION');

    if v_manual_status<>'RESERVED'
       or v_manual_notification<>0
    then
      raise exception 'NO_SHOW_MANUAL_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'before_grace_status',v_status,
      'before_grace_marked',coalesce((v_before->>'marked_no_show')::integer,0),
      'after_grace_status',v_auto_status,
      'after_grace_marked',coalesce((v_after->>'marked_no_show')::integer,0),
      'automatic_audit_created',v_auto_audit>=1,
      'automatic_notification_count',v_auto_notification,
      'suggested_status',v_suggest_status,
      'suggested_count',coalesce((v_suggest_result->>'suggested')::integer,0),
      'suggestion_notification_count',v_suggest_notification,
      'suggestion_deduplicated',v_suggest_notification=1,
      'manual_status',v_manual_status,
      'manual_notifications',v_manual_notification,
      'grace_minutes',15,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_NO_SHOW_TEST__'
      using detail=v_evidence::text;

  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_NO_SHOW_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_reservation_no_show_grace_period()
from public,anon,authenticated;
grant execute on function private.test_reservation_no_show_grace_period()
to service_role,postgres;
