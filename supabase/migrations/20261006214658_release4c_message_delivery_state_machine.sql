
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

  update public.message_jobs j
  set state='FAILED',
      failed_at=clock_timestamp(),
      lease_token=null,
      lease_until=null,
      last_error_code='MESSAGE_OUTCOME_UNKNOWN'
  where j.state='SENDING'
    and j.lease_until<clock_timestamp();

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='RESERVATION_NOT_MESSAGEABLE'
  where j.state='QUEUED'
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
      last_error_code='MESSAGE_PROVIDER_CHANGED'
  where j.state='QUEUED'
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
  where j.state='QUEUED'
    and j.next_attempt_at<=clock_timestamp()
    and j.scheduled_for<=clock_timestamp()
    and j.attempts<j.max_attempts
  order by j.next_attempt_at,j.created_at,j.id
  for update skip locked
  limit 1;

  if v_job.id is null then
    return jsonb_build_object('status','IDLE');
  end if;

  update public.message_jobs
  set state='SENDING',
      attempts=attempts+1,
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

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

  return jsonb_build_object(
    'status','CLAIMED',
    'id',v_job.id,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'sender_ref',v_setting.sender_ref,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'template_data',v_payload.template_data
  );
end
$$;

create or replace function public.finish_message_job(
  p_job uuid,
  p_lease uuid,
  p_state text,
  p_provider_message_id text,
  p_event_id text,
  p_error_code text,
  p_retryable boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_setting public.message_provider_settings;
  v_event private.message_provider_events;
  v_next timestamptz;
  v_backoff integer;
begin
  if p_job is null
     or p_lease is null
     or p_state not in ('SENT','FAILED')
     or p_retryable is null
     or (p_provider_message_id is not null and length(p_provider_message_id) not between 1 and 240)
     or (p_event_id is not null and length(p_event_id) not between 1 and 240)
     or (p_error_code is not null and length(p_error_code) not between 1 and 120)
  then
    raise exception 'INVALID_MESSAGE_RESULT';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  if v_job.state='CANCELLED' then
    return jsonb_build_object('id',v_job.id,'state','CANCELLED');
  end if;

  if p_event_id is not null then
    select * into v_event
    from private.message_provider_events
    where adapter=v_job.adapter and event_id=p_event_id;

    if v_event.event_id is not null then
      if v_event.job_id<>v_job.id or v_event.state<>p_state then
        raise exception 'MESSAGE_PROVIDER_EVENT_MISMATCH';
      end if;
      return jsonb_build_object(
        'id',v_job.id,
        'state',v_job.state,
        'provider_message_id',v_job.provider_message_id
      );
    end if;
  end if;

  if v_job.state<>'SENDING'
     or v_job.lease_token is distinct from p_lease
  then
    raise exception 'LEASE_CONFLICT';
  end if;

  if p_state='SENT' then
    if p_provider_message_id is null or p_event_id is null then
      raise exception 'MESSAGE_PROVIDER_ID_REQUIRED';
    end if;

    insert into private.message_provider_events(
      adapter,event_id,job_id,state
    ) values(
      v_job.adapter,p_event_id,v_job.id,'SENT'
    );

    update public.message_jobs
    set state='SENT',
        provider_message_id=p_provider_message_id,
        sent_at=clock_timestamp(),
        lease_token=null,
        lease_until=null,
        last_error_code=null
    where id=v_job.id
    returning * into v_job;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if p_error_code is null then
    raise exception 'MESSAGE_ERROR_CODE_REQUIRED';
  end if;

  if p_event_id is not null and p_provider_message_id is not null then
    insert into private.message_provider_events(
      adapter,event_id,job_id,state
    ) values(
      v_job.adapter,p_event_id,v_job.id,'FAILED'
    );
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_job.venue_id
    and channel=v_job.channel;

  if p_retryable and v_job.attempts<v_job.max_attempts then
    v_backoff:=least(
      coalesce(v_setting.max_backoff_seconds,1800),
      coalesce(v_setting.base_backoff_seconds,30)
        * (2^greatest(v_job.attempts-1,0))::integer
    );
    v_next:=clock_timestamp()+make_interval(secs=>v_backoff);

    update public.message_jobs
    set state='QUEUED',
        next_attempt_at=v_next,
        lease_token=null,
        lease_until=null,
        last_error_code=p_error_code
    where id=v_job.id
    returning * into v_job;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'next_attempt_at',v_job.next_attempt_at,
      'attempts',v_job.attempts
    );
  end if;

  update public.message_jobs
  set state='FAILED',
      failed_at=clock_timestamp(),
      lease_token=null,
      lease_until=null,
      last_error_code=p_error_code
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts,
    'error_code',v_job.last_error_code
  );
end
$$;

create or replace function public.apply_message_delivery_event(
  p_job uuid,
  p_adapter text,
  p_event_id text,
  p_provider_message_id text,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_event private.message_provider_events;
begin
  if p_job is null
     or p_adapter not in ('TWILIO','TELEGRAM','MOCK')
     or p_event_id is null
     or length(p_event_id) not between 1 and 240
     or p_provider_message_id is null
     or length(p_provider_message_id) not between 1 and 240
     or p_state not in ('DELIVERED','FAILED')
  then
    raise exception 'INVALID_DELIVERY_EVENT';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;
  if v_job.adapter<>p_adapter then
    raise exception 'MESSAGE_ADAPTER_MISMATCH';
  end if;

  select * into v_event
  from private.message_provider_events
  where adapter=p_adapter and event_id=p_event_id;

  if v_event.event_id is not null then
    if v_event.job_id<>p_job or v_event.state<>p_state then
      raise exception 'MESSAGE_PROVIDER_EVENT_MISMATCH';
    end if;
    return jsonb_build_object('id',v_job.id,'state',v_job.state);
  end if;

  if v_job.state='CANCELLED' then
    return jsonb_build_object('id',v_job.id,'state','CANCELLED');
  end if;

  if v_job.provider_message_id is not null
     and v_job.provider_message_id<>p_provider_message_id
  then
    raise exception 'MESSAGE_PROVIDER_ID_MISMATCH';
  end if;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state
  ) values(
    p_adapter,p_event_id,p_job,p_state
  );

  if p_state='DELIVERED' then
    update public.message_jobs
    set state='DELIVERED',
        provider_message_id=p_provider_message_id,
        sent_at=coalesce(sent_at,clock_timestamp()),
        delivered_at=clock_timestamp(),
        lease_token=null,
        lease_until=null,
        last_error_code=null
    where id=p_job
    returning * into v_job;
  else
    update public.message_jobs
    set state='FAILED',
        provider_message_id=coalesce(provider_message_id,p_provider_message_id),
        failed_at=clock_timestamp(),
        lease_token=null,
        lease_until=null,
        last_error_code='PROVIDER_DELIVERY_FAILED'
    where id=p_job
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id
  );
end
$$;

revoke all on function public.claim_message_job(integer)
from public,anon,authenticated;
grant execute on function public.claim_message_job(integer)
to service_role,postgres;

revoke all on function public.finish_message_job(
  uuid,uuid,text,text,text,text,boolean
) from public,anon,authenticated;
grant execute on function public.finish_message_job(
  uuid,uuid,text,text,text,text,boolean
) to service_role,postgres;

revoke all on function public.apply_message_delivery_event(
  uuid,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.apply_message_delivery_event(
  uuid,text,text,text,text
) to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_message_job(integer)','service_role'),
  ('public.finish_message_job(uuid,uuid,text,text,text,text,boolean)','service_role'),
  ('public.apply_message_delivery_event(uuid,text,text,text,text)','service_role')
on conflict do nothing;
