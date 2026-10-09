
create or replace function private.test_reservation_no_show_deposit_policy()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_venue uuid;
  v_service uuid;
  v_base date:=date '2099-01-01';
  v_manual uuid:=gen_random_uuid();
  v_retain uuid:=gen_random_uuid();
  v_full uuid:=gen_random_uuid();
  v_partial uuid:=gen_random_uuid();
  v_d_manual uuid:=gen_random_uuid();
  v_d_retain uuid:=gen_random_uuid();
  v_d_full uuid:=gen_random_uuid();
  v_d_partial uuid:=gen_random_uuid();
  v_manual_action jsonb;
  v_retain_action jsonb;
  v_full_action jsonb;
  v_partial_action jsonb;
  v_dep_state text;
  v_dep_refunded bigint;
  v_manual_notifications integer;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    select v.id,s.id
    into v_venue,v_service
    from public.venues v
    join public.services s on s.venue_id=v.id and s.active
    where v.active and v.operational_status='OPEN'
    order by v.id,s.id
    limit 1;

    if v_venue is null then
      raise exception 'NO_SHOW_DEPOSIT_TEST_FIXTURE_UNAVAILABLE';
    end if;

    insert into public.service_booking_rules(
      venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,
      max_party_size_auto_confirm,large_party_mode,deposit_policy,
      no_show_mode,no_show_grace_minutes,deposit_no_show_action
    ) values(
      v_venue,v_service,100,5,100,100,8,'REQUESTED','DISABLED',
      'NO_SHOW_MANUAL',15,'MANUAL'
    )
    on conflict(service_id) do update
    set deposit_no_show_action='MANUAL',
        deposit_no_show_refund_bps=null,
        updated_at=clock_timestamp();

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values
      (v_manual,v_venue,v_service,v_base,'18:00','Policy','Manual','+390000002001',2,'RESERVED',false),
      (v_retain,v_venue,v_service,v_base,'18:05','Policy','Retain','+390000002002',2,'RESERVED',false),
      (v_full,v_venue,v_service,v_base,'18:10','Policy','Full','+390000002003',2,'RESERVED',false),
      (v_partial,v_venue,v_service,v_base,'18:15','Policy','Partial','+390000002004',2,'RESERVED',false);

    insert into public.reservation_deposits(
      id,reservation_id,venue_id,amount_cents,currency,provider,
      provider_reference,status,expires_at,completed_at,refunded_amount_cents
    ) values
      (v_d_manual,v_manual,v_venue,5000,'EUR','STRIPE','cs_manual','COMPLETED',clock_timestamp()+interval '1 day',clock_timestamp(),0),
      (v_d_retain,v_retain,v_venue,5000,'EUR','STRIPE','cs_retain','COMPLETED',clock_timestamp()+interval '1 day',clock_timestamp(),0),
      (v_d_full,v_full,v_venue,5000,'EUR','STRIPE','cs_full','PARTIALLY_REFUNDED',clock_timestamp()+interval '1 day',clock_timestamp(),1000),
      (v_d_partial,v_partial,v_venue,5000,'EUR','SATISPAY','pay_partial','PARTIALLY_REFUNDED',clock_timestamp()+interval '1 day',clock_timestamp(),1000);

    update public.reservations set status='NO_SHOW' where id=v_manual;

    select to_jsonb(a) into v_manual_action
    from private.reservation_deposit_no_show_actions a
    where a.deposit_id=v_d_manual;

    select count(*)::integer into v_manual_notifications
    from public.notifications
    where resource_type='reservation_deposit_no_show_actions'
      and resource_id=(v_manual_action->>'id')::uuid
      and category='DEPOSIT_NO_SHOW_ACTION_REQUIRED';

    update public.service_booking_rules
    set deposit_no_show_action='RETAIN',
        deposit_no_show_refund_bps=null
    where service_id=v_service;
    update public.reservations set status='NO_SHOW' where id=v_retain;

    select to_jsonb(a) into v_retain_action
    from private.reservation_deposit_no_show_actions a
    where a.deposit_id=v_d_retain;

    update public.service_booking_rules
    set deposit_no_show_action='REFUND_FULL',
        deposit_no_show_refund_bps=null
    where service_id=v_service;
    update public.reservations set status='NO_SHOW' where id=v_full;

    select to_jsonb(a) into v_full_action
    from private.reservation_deposit_no_show_actions a
    where a.deposit_id=v_d_full;

    select status,refunded_amount_cents
    into v_dep_state,v_dep_refunded
    from public.reservation_deposits
    where id=v_d_full;

    if v_dep_state<>'PARTIALLY_REFUNDED' or v_dep_refunded<>1000 then
      raise exception 'DEPOSIT_MUTATED_BEFORE_PROVIDER_CONFIRMATION';
    end if;

    update public.service_booking_rules
    set deposit_no_show_action='PARTIAL_REFUND',
        deposit_no_show_refund_bps=5000
    where service_id=v_service;
    update public.reservations set status='NO_SHOW' where id=v_partial;

    select to_jsonb(a) into v_partial_action
    from private.reservation_deposit_no_show_actions a
    where a.deposit_id=v_d_partial;

    if v_manual_action->>'state'<>'MANUAL_REQUIRED'
       or v_manual_notifications<>1
       or v_retain_action->>'state'<>'RETAINED'
       or (v_full_action->>'state')<>'QUEUED'
       or (v_full_action->>'target_refund_cents')::bigint<>5000
       or (v_full_action->>'requested_refund_cents')::bigint<>4000
       or (v_partial_action->>'state')<>'QUEUED'
       or (v_partial_action->>'target_refund_cents')::bigint<>2500
       or (v_partial_action->>'requested_refund_cents')::bigint<>1500
    then
      raise exception 'NO_SHOW_DEPOSIT_POLICY_ASSERTION_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'manual_state',v_manual_action->>'state',
      'manual_notification_count',v_manual_notifications,
      'retain_state',v_retain_action->>'state',
      'full_state',v_full_action->>'state',
      'full_target_refund_cents',(v_full_action->>'target_refund_cents')::bigint,
      'full_requested_refund_cents',(v_full_action->>'requested_refund_cents')::bigint,
      'partial_state',v_partial_action->>'state',
      'partial_refund_bps',5000,
      'partial_target_refund_cents',(v_partial_action->>'target_refund_cents')::bigint,
      'partial_requested_refund_cents',(v_partial_action->>'requested_refund_cents')::bigint,
      'deposit_state_before_provider_confirmation',v_dep_state,
      'deposit_refunded_before_provider_confirmation',v_dep_refunded,
      'provider_authoritative',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_NO_SHOW_DEPOSIT_TEST__'
      using detail=v_evidence::text;

  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_NO_SHOW_DEPOSIT_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_reservation_no_show_deposit_policy()
from public,anon,authenticated;
grant execute on function private.test_reservation_no_show_deposit_policy()
to service_role,postgres;
