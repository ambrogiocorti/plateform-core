
create or replace function private.test_reservation_no_show_deposit_provider_state_machine()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_venue uuid;
  v_service uuid;
  v_res uuid:=gen_random_uuid();
  v_dep uuid:=gen_random_uuid();
  v_action uuid:=gen_random_uuid();
  v_res_unknown uuid:=gen_random_uuid();
  v_dep_unknown uuid:=gen_random_uuid();
  v_action_unknown uuid:=gen_random_uuid();
  v_claim jsonb;
  v_wait jsonb;
  v_claim2 jsonb;
  v_done jsonb;
  v_duplicate jsonb;
  v_unknown_claim jsonb;
  v_unknown jsonb;
  v_dep_status text;
  v_refunded bigint;
  v_wait_state text;
  v_recon_state text;
  v_recon_notifications integer;
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
      raise exception 'PROVIDER_STATE_TEST_FIXTURE_UNAVAILABLE';
    end if;

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_res,v_venue,v_service,date '2099-02-01','18:00',
      'Provider','State','+390000003001',2,'NO_SHOW',false
    );

    insert into public.reservation_deposits(
      id,reservation_id,venue_id,amount_cents,currency,provider,
      provider_reference,status,expires_at,completed_at,refunded_amount_cents
    ) values(
      v_dep,v_res,v_venue,5000,'EUR','STRIPE',
      'cs_provider_state','COMPLETED',
      clock_timestamp()+interval '1 day',clock_timestamp(),0
    );

    insert into private.reservation_deposit_no_show_actions(
      id,deposit_id,reservation_id,venue_id,reservation_version,
      policy,target_refund_cents,requested_refund_cents,
      provider,provider_payment_id,state,next_attempt_at
    ) values(
      v_action,v_dep,v_res,v_venue,1,
      'REFUND_FULL',5000,5000,
      'STRIPE','cs_provider_state','QUEUED',clock_timestamp()-interval '1 second'
    );

    v_claim:=public.claim_reservation_deposit_no_show_action(90);

    if (v_claim->>'id')::uuid<>v_action
       or v_claim->>'status'<>'CLAIMED'
    then
      raise exception 'PROVIDER_CLAIM_FAILED';
    end if;

    v_wait:=public.finish_reservation_deposit_no_show_action(
      v_action,
      (v_claim->>'lease_token')::uuid,
      're_provider_state',
      'WAITING',
      5000,
      'EUR',
      'probe-provider-waiting',
      null
    );

    select state into v_wait_state
    from private.reservation_deposit_no_show_actions
    where id=v_action;

    select status,refunded_amount_cents
    into v_dep_status,v_refunded
    from public.reservation_deposits
    where id=v_dep;

    if v_wait_state<>'WAITING'
       or v_dep_status<>'COMPLETED'
       or v_refunded<>0
    then
      raise exception 'WAITING_MUTATED_DEPOSIT';
    end if;

    update private.reservation_deposit_no_show_actions
    set next_attempt_at=clock_timestamp()-interval '1 second'
    where id=v_action;

    v_claim2:=public.claim_reservation_deposit_no_show_action(90);

    if (v_claim2->>'id')::uuid<>v_action
       or v_claim2->>'provider_refund_id'<>'re_provider_state'
    then
      raise exception 'PROVIDER_POLL_CLAIM_FAILED';
    end if;

    v_done:=public.finish_reservation_deposit_no_show_action(
      v_action,
      (v_claim2->>'lease_token')::uuid,
      're_provider_state',
      'COMPLETED',
      5000,
      'EUR',
      'probe-provider-completed',
      null
    );

    select status,refunded_amount_cents
    into v_dep_status,v_refunded
    from public.reservation_deposits
    where id=v_dep;

    if v_dep_status<>'REFUNDED' or v_refunded<>5000 then
      raise exception 'COMPLETED_DID_NOT_MUTATE_DEPOSIT';
    end if;

    v_duplicate:=public.finish_reservation_deposit_no_show_action(
      v_action,
      gen_random_uuid(),
      're_provider_state',
      'COMPLETED',
      5000,
      'EUR',
      'probe-provider-completed',
      null
    );

    if coalesce((v_duplicate->>'duplicate_event')::boolean,false)<>true
       or v_duplicate->>'state'<>'COMPLETED'
    then
      raise exception 'DUPLICATE_PROVIDER_EVENT_NOT_IDEMPOTENT';
    end if;

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_res_unknown,v_venue,v_service,date '2099-02-01','18:05',
      'Provider','Unknown','+390000003002',2,'NO_SHOW',false
    );

    insert into public.reservation_deposits(
      id,reservation_id,venue_id,amount_cents,currency,provider,
      provider_reference,status,expires_at,completed_at,refunded_amount_cents
    ) values(
      v_dep_unknown,v_res_unknown,v_venue,3000,'EUR','SATISPAY',
      'pay_provider_unknown','COMPLETED',
      clock_timestamp()+interval '1 day',clock_timestamp(),0
    );

    insert into private.reservation_deposit_no_show_actions(
      id,deposit_id,reservation_id,venue_id,reservation_version,
      policy,target_refund_cents,requested_refund_cents,
      provider,provider_payment_id,state,next_attempt_at
    ) values(
      v_action_unknown,v_dep_unknown,v_res_unknown,v_venue,1,
      'REFUND_FULL',3000,3000,
      'SATISPAY','pay_provider_unknown','QUEUED',clock_timestamp()-interval '1 second'
    );

    v_unknown_claim:=public.claim_reservation_deposit_no_show_action(90);

    if (v_unknown_claim->>'id')::uuid<>v_action_unknown then
      raise exception 'UNKNOWN_CLAIM_FAILED';
    end if;

    v_unknown:=public.release_reservation_deposit_no_show_action_unknown(
      v_action_unknown,
      (v_unknown_claim->>'lease_token')::uuid,
      'REMOTE_OUTCOME_UNKNOWN'
    );

    select state into v_recon_state
    from private.reservation_deposit_no_show_actions
    where id=v_action_unknown;

    select status,refunded_amount_cents
    into v_dep_status,v_refunded
    from public.reservation_deposits
    where id=v_dep_unknown;

    select count(*)::integer into v_recon_notifications
    from public.notifications
    where resource_type='reservation_deposit_no_show_actions'
      and resource_id=v_action_unknown
      and category='DEPOSIT_REFUND_RECONCILIATION';

    if v_recon_state<>'RECONCILIATION_REQUIRED'
       or v_dep_status<>'COMPLETED'
       or v_refunded<>0
       or v_recon_notifications<>1
    then
      raise exception 'UNKNOWN_OUTCOME_FAILSAFE_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'initial_claim','CLAIMED',
      'waiting_state',v_wait_state,
      'deposit_unchanged_while_waiting',true,
      'known_refund_id_repolled',true,
      'completed_action_state',v_done->>'state',
      'deposit_status_after_verified_completion','REFUNDED',
      'deposit_refunded_cents_after_completion',5000,
      'duplicate_provider_event_idempotent',true,
      'unknown_outcome_state',v_recon_state,
      'unknown_outcome_deposit_unchanged',true,
      'reconciliation_notification_count',v_recon_notifications,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_PROVIDER_STATE_TEST__'
      using detail=v_evidence::text;

  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_PROVIDER_STATE_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_reservation_no_show_deposit_provider_state_machine()
from public,anon,authenticated;
grant execute on function private.test_reservation_no_show_deposit_provider_state_machine()
to service_role,postgres;
