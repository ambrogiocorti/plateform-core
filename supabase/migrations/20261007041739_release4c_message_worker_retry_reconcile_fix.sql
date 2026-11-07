
create or replace function public.claim_message_job(
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_payload private.message_job_payloads;
  v_setting public.message_provider_settings;
begin
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception 'INVALID_LEASE';
  end if;

  -- A lease expiring while a remote request may already have been accepted is
  -- an unknown outcome. Never retry it blindly.
  update public.message_jobs j
  set state='RECONCILIATION_REQUIRED',
      lease_token=null,
      lease_until=null,
      last_error_code='REMOTE_OUTCOME_UNKNOWN'
  where j.state='SENDING'
    and j.lease_until<clock_timestamp();

  -- A reservation that is no longer messageable invalidates queued/retry jobs.
  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='RESERVATION_NOT_MESSAGEABLE'
  where j.state in ('QUEUED','FAILED')
    and j.reservation_id is not null
    and not exists(
      select 1
      from public.reservations r
      where r.id=j.reservation_id
        and r.status='RESERVED'
        and not r.walk_in
        and r.anonymized_at is null
    );

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='MESSAGE_FEATURE_DISABLED'
  where j.state in ('QUEUED','FAILED')
    and not private.message_channel_enabled(j.venue_id,j.channel);

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='MESSAGE_PROVIDER_CHANGED'
  where j.state in ('QUEUED','FAILED')
    and not exists(
      select 1
      from public.message_provider_settings s
      where s.venue_id=j.venue_id
        and s.channel=j.channel
        and s.adapter=j.adapter
        and s.enabled
    );

  select j.*
  into v_job
  from public.message_jobs j
  where j.state in ('QUEUED','FAILED')
    and j.next_attempt_at<=clock_timestamp()
    and j.scheduled_for<=clock_timestamp()
    and j.attempts<j.max_attempts
    and private.message_channel_enabled(j.venue_id,j.channel)
  order by j.next_attempt_at,j.created_at,j.id
  for update skip locked
  limit 1;

  if v_job.id is null then
    return jsonb_build_object('status','IDLE');
  end if;

  select * into v_payload
  from private.message_job_payloads
  where job_id=v_job.id;

  if v_payload.job_id is null then
    raise exception 'MESSAGE_PAYLOAD_MISSING';
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_job.venue_id
    and channel=v_job.channel
    and adapter=v_job.adapter
    and enabled;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_PROVIDER_CHANGED';
  end if;

  update public.message_jobs
  set state='SENDING',
      attempts=attempts+1,
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'status','CLAIMED',
    'id',v_job.id,
    'provider_idempotency_key',v_job.id,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'unknown_outcome_policy',v_setting.unknown_outcome_policy,
    'sender_ref',v_setting.sender_ref,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'body_template',v_payload.body_template,
    'provider_template_ref',v_payload.provider_template_ref,
    'template_data',v_payload.template_data
  );
end
$$;
