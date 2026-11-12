
create or replace function private.test_waitlist_offer_message_bridge()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service constant uuid:='c6d755c7-647e-430c-8685-cc0c8cba8fdd'::uuid;
  v_active_entry uuid:=gen_random_uuid();
  v_expired_entry uuid:=gen_random_uuid();
  v_settings_version bigint;
  v_config jsonb;
  v_active_offer jsonb;
  v_expired_offer jsonb;
  v_active_job public.message_jobs;
  v_expired_job public.message_jobs;
  v_active_payload private.message_job_payloads;
  v_claim jsonb;
  v_expired_state text;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user::text,
        'session_id',v_session::text,
        'iat',extract(epoch from clock_timestamp())::bigint,
        'aal','aal2',
        'role','authenticated',
        'amr',jsonb_build_array(
          jsonb_build_object(
            'method','password',
            'timestamp',extract(epoch from clock_timestamp())::bigint
          )
        )
      )::text,
      true
    );
    perform set_config('request.headers','{}',true);

    update private.staff_sessions
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session
      and user_id=v_user
      and revoked_at is null;

    if not found
       or private.current_role() is distinct from 'ADMIN'::public.user_role
    then
      raise exception 'WAITLIST_MESSAGE_TEST_AUTH_FAILED';
    end if;

    update public.feature_flags
    set licensed=true
    where name in (
      'WAITLIST',
      'RESERVATION_MESSAGING',
      'WHATSAPP_TELEGRAM_SMS_MESSAGING'
    );

    insert into public.venue_features(venue_id,name,enabled)
    values
      (v_venue,'WAITLIST',true),
      (v_venue,'RESERVATION_MESSAGING',true),
      (v_venue,'WHATSAPP_TELEGRAM_SMS_MESSAGING',true)
    on conflict(venue_id,name) do update
    set enabled=true,updated_at=clock_timestamp();

    insert into public.service_booking_rules(
      venue_id,service_id,max_covers_service,slot_interval_minutes,
      max_arrivals_per_slot,max_covers_per_slot,max_party_size_auto_confirm,
      large_party_mode,deposit_policy,no_show_mode,no_show_grace_minutes,
      deposit_no_show_action
    ) values(
      v_venue,v_service,20,30,10,20,8,
      'REQUESTED','DISABLED','NO_SHOW_MANUAL',15,'MANUAL'
    )
    on conflict(service_id) do update
    set max_covers_service=20,
        slot_interval_minutes=30,
        max_arrivals_per_slot=10,
        max_covers_per_slot=20,
        max_party_size_auto_confirm=8,
        large_party_mode='REQUESTED',
        deposit_policy='DISABLED',
        updated_at=clock_timestamp();

    insert into public.message_provider_settings(
      venue_id,channel,adapter,enabled,max_attempts,
      base_backoff_seconds,max_backoff_seconds,unknown_outcome_policy
    ) values(
      v_venue,'WHATSAPP','MOCK',true,3,5,30,'RECONCILE'
    )
    on conflict(venue_id,channel) do update
    set adapter='MOCK',
        enabled=true,
        max_attempts=3,
        base_backoff_seconds=5,
        max_backoff_seconds=30,
        unknown_outcome_policy='RECONCILE',
        updated_at=clock_timestamp();

    insert into public.message_templates(
      id,venue_id,channel,template_key,locale,
      body_template,provider_template_ref,active
    ) values(
      gen_random_uuid(),v_venue,'WHATSAPP','waitlist_offer','it-IT',
      'Ciao {{customer_name}}, posto disponibile alle {{waitlist_offer_time}}. Accetta: {{waitlist_accept_url}}',
      null,true
    )
    on conflict(venue_id,channel,template_key) do update
    set locale='it-IT',
        body_template=excluded.body_template,
        provider_template_ref=null,
        active=true,
        updated_at=clock_timestamp();

    if not private.message_template_variables_valid(
      'Accetta qui: {{waitlist_accept_url}}'
    ) or private.message_template_variables_valid(
      'Token grezzo: {{waitlist_access_token}}'
    ) then
      raise exception 'WAITLIST_TEMPLATE_VARIABLE_POLICY_FAILED';
    end if;

    select version into v_settings_version
    from public.waitlist_settings
    where venue_id=v_venue;

    v_config:=public.configure_waitlist_messaging(
      v_venue,true,v_settings_version,gen_random_uuid()
    );

    if not coalesce((v_config->>'message_offers_enabled')::boolean,false) then
      raise exception 'WAITLIST_MESSAGE_CONFIG_ENABLE_FAILED';
    end if;

    update public.message_jobs
    set next_attempt_at=clock_timestamp()+interval '1 hour'
    where state in ('QUEUED','FAILED');

    insert into public.waitlist_entries(
      id,venue_id,service_id,service_date,
      preferred_start_time,preferred_end_time,party_size,
      customer_name,customer_phone,notes,status
    ) values
      (
        v_active_entry,v_venue,v_service,date '2099-04-04',
        time '21:00',time '21:30',2,
        'E2E Active','+393331111111','bridge active','WAITING'
      ),
      (
        v_expired_entry,v_venue,v_service,date '2099-04-05',
        time '21:00',time '21:30',2,
        'E2E Expired','+393332222222','bridge expired','WAITING'
      );

    v_active_offer:=public.offer_waitlist_slot(
      v_active_entry,time '21:00',15,gen_random_uuid()
    );

    v_expired_offer:=public.offer_waitlist_slot(
      v_expired_entry,time '21:00',15,gen_random_uuid()
    );

    if (v_active_offer->>'message_jobs_queued')::integer<>1
       or (v_expired_offer->>'message_jobs_queued')::integer<>1
       or length(v_active_offer->>'access_token')<>64
    then
      raise exception 'WAITLIST_MESSAGE_QUEUE_FAILED';
    end if;

    select * into v_active_job
    from public.message_jobs
    where resource_type='waitlist_entries'
      and resource_id=v_active_entry
      and event_type='WAITLIST_OFFER';

    select * into v_expired_job
    from public.message_jobs
    where resource_type='waitlist_entries'
      and resource_id=v_expired_entry
      and event_type='WAITLIST_OFFER';

    if v_active_job.id is null
       or v_active_job.reservation_id is not null
       or v_active_job.channel<>'WHATSAPP'
       or v_active_job.adapter<>'MOCK'
       or v_active_job.state<>'QUEUED'
       or v_expired_job.id is null
    then
      raise exception 'WAITLIST_MESSAGE_JOB_SHAPE_FAILED';
    end if;

    select * into v_active_payload
    from private.message_job_payloads
    where job_id=v_active_job.id;

    if v_active_payload.destination<> '+393331111111'
       or v_active_payload.template_key<>'waitlist_offer'
       or v_active_payload.template_data->>'waitlist_entry_id'<>v_active_entry::text
       or v_active_payload.template_data->>'waitlist_access_token'
            is distinct from v_active_offer->>'access_token'
       or v_active_payload.template_data ? 'waitlist_accept_url'
    then
      raise exception 'WAITLIST_PRIVATE_PAYLOAD_FAILED';
    end if;

    update public.waitlist_entries
    set offer_expires_at=clock_timestamp()-interval '1 second'
    where id=v_expired_entry;

    v_claim:=public.claim_message_job(60);

    select state into v_expired_state
    from public.message_jobs
    where id=v_expired_job.id;

    if v_expired_state<>'CANCELLED'
       or v_claim->>'status'<>'CLAIMED'
       or (v_claim->>'id')::uuid<>v_active_job.id
       or v_claim->>'event_type'<>'WAITLIST_OFFER'
       or v_claim->>'resource_type'<>'waitlist_entries'
       or (v_claim->>'resource_id')::uuid<>v_active_entry
       or v_claim->'template_data'->>'waitlist_access_token'
            is distinct from v_active_offer->>'access_token'
    then
      raise exception 'WAITLIST_MESSAGE_CLAIM_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'admin_configuration_enabled',true,
      'template_accept_url_variable_allowed',true,
      'raw_token_template_variable_rejected',true,
      'offer_queues_message_job',true,
      'reservation_id_fabricated',false,
      'resource_type','waitlist_entries',
      'channel','WHATSAPP',
      'adapter','MOCK',
      'raw_token_stored_private_only',true,
      'accept_url_not_stored_in_database_payload',true,
      'active_offer_claimed',true,
      'expired_offer_job_state',v_expired_state,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_WAITLIST_MESSAGE_BRIDGE_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_WAITLIST_MESSAGE_BRIDGE_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_waitlist_offer_message_bridge()
from public,anon,authenticated;
grant execute on function private.test_waitlist_offer_message_bridge()
to service_role,postgres;
