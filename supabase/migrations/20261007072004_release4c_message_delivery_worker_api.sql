
create or replace function public.claim_message_job(
  p_job uuid
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
  v_now timestamptz:=clock_timestamp();
begin
  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then
    raise exception 'NOT_FOUND';
  end if;

  perform private.require_reservation_message_channel(
    v_job.venue_id,
    v_job.channel
  );

  if v_job.state in ('SENT','DELIVERED','CANCELLED') then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'terminal',true
    );
  end if;

  if v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'terminal',true
    );
  end if;

  if v_job.state='SENDING'
     and v_job.lease_until is not null
     and v_job.lease_until>v_now then
    raise exception 'MESSAGE_IN_PROGRESS';
  end if;

  if v_job.next_attempt_at>v_now then
    raise exception 'MESSAGE_NOT_DUE';
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
    and enabled;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_CHANNEL_DISABLED';
  end if;

  update public.message_jobs
  set state='SENDING',
      lease_token=gen_random_uuid(),
      lease_until=v_now+interval '60 seconds',
      attempts=attempts+1,
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'id',v_job.id,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'sender_ref',v_setting.sender_ref,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'template_data',v_payload.template_data
  );
end
$$;

create or replace function public.fail_message_attempt(
  p_job uuid,
  p_lease uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_setting public.message_provider_settings;
  v_delay integer;
  v_terminal boolean;
begin
  if p_error_code is null
     or length(trim(p_error_code)) not between 1 and 120 then
    raise exception 'INVALID_MESSAGE_ERROR';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  if v_job.state in ('SENT','DELIVERED','CANCELLED') then
    return jsonb_build_object(
      'id',v_job.id,'state',v_job.state,'terminal',true
    );
  end if;

  if v_job.state<>'SENDING'
     or p_lease is null
     or v_job.lease_token is distinct from p_lease then
    raise exception 'MESSAGE_LEASE_CONFLICT';
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_job.venue_id
    and channel=v_job.channel;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_PROVIDER_SETTING_MISSING';
  end if;

  v_terminal:=v_job.attempts>=v_job.max_attempts;

  if v_terminal then
    update public.message_jobs
    set state='FAILED',
        lease_token=null,
        lease_until=null,
        last_error_code=upper(trim(p_error_code)),
        failed_at=clock_timestamp()
    where id=v_job.id
    returning * into v_job;
  else
    v_delay:=least(
      v_setting.max_backoff_seconds,
      v_setting.base_backoff_seconds
        * (2 ^ greatest(v_job.attempts-1,0))::integer
    );

    update public.message_jobs
    set state='QUEUED',
        lease_token=null,
        lease_until=null,
        last_error_code=upper(trim(p_error_code)),
        next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay),
        failed_at=null
    where id=v_job.id
    returning * into v_job;
  end if;

  perform private.audit(
    case when v_terminal then 'MESSAGE_DELIVERY_FAILED'
         else 'MESSAGE_DELIVERY_RETRY_SCHEDULED' end,
    'message_jobs',
    v_job.id,
    v_job.venue_id,
    null,
    jsonb_build_object(
      'channel',v_job.channel,
      'adapter',v_job.adapter,
      'attempts',v_job.attempts,
      'max_attempts',v_job.max_attempts,
      'error_code',upper(trim(p_error_code)),
      'next_attempt_at',v_job.next_attempt_at
    )
  );

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'terminal',v_terminal,
    'error_code',v_job.last_error_code
  );
end
$$;

create or replace function public.finish_message_job(
  p_job uuid,
  p_lease uuid,
  p_provider_message_id text,
  p_state text,
  p_event_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_existing private.message_provider_events;
  v_state text:=upper(trim(p_state));
begin
  if p_provider_message_id is null
     or length(trim(p_provider_message_id)) not between 1 and 240
     or p_event_id is null
     or length(trim(p_event_id)) not between 1 and 240
     or v_state not in ('SENT','DELIVERED','FAILED')
  then
    raise exception 'INVALID_MESSAGE_PROVIDER_RESULT';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  select * into v_existing
  from private.message_provider_events
  where adapter=v_job.adapter
    and event_id=trim(p_event_id);

  if v_existing.event_id is not null then
    if v_existing.job_id<>v_job.id
       or v_existing.state<>v_state then
      raise exception 'MESSAGE_PROVIDER_EVENT_MISMATCH';
    end if;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id,
      'replayed',true
    );
  end if;

  if v_job.state='DELIVERED' then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id,
      'replayed',false
    );
  end if;

  if v_job.state='SENDING' then
    if p_lease is null or v_job.lease_token is distinct from p_lease then
      raise exception 'MESSAGE_LEASE_CONFLICT';
    end if;
  elsif v_job.state='SENT' then
    if v_state not in ('DELIVERED','FAILED') then
      raise exception 'INVALID_MESSAGE_TRANSITION';
    end if;
  else
    raise exception 'INVALID_MESSAGE_TRANSITION';
  end if;

  if v_job.provider_message_id is not null
     and v_job.provider_message_id<>trim(p_provider_message_id) then
    raise exception 'MESSAGE_PROVIDER_ID_MISMATCH';
  end if;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state
  ) values(
    v_job.adapter,trim(p_event_id),v_job.id,v_state
  );

  update public.message_jobs
  set state=v_state,
      provider_message_id=trim(p_provider_message_id),
      lease_token=null,
      lease_until=null,
      sent_at=case
        when v_state in ('SENT','DELIVERED')
          then coalesce(sent_at,clock_timestamp())
        else sent_at
      end,
      delivered_at=case
        when v_state='DELIVERED'
          then coalesce(delivered_at,clock_timestamp())
        else delivered_at
      end,
      failed_at=case
        when v_state='FAILED' then clock_timestamp()
        else failed_at
      end,
      last_error_code=case
        when v_state='FAILED' then 'PROVIDER_REPORTED_FAILED'
        else null
      end
  where id=v_job.id
  returning * into v_job;

  perform private.audit(
    case v_state
      when 'SENT' then 'MESSAGE_SENT'
      when 'DELIVERED' then 'MESSAGE_DELIVERED'
      else 'MESSAGE_DELIVERY_FAILED'
    end,
    'message_jobs',
    v_job.id,
    v_job.venue_id,
    null,
    jsonb_build_object(
      'channel',v_job.channel,
      'adapter',v_job.adapter,
      'state',v_job.state,
      'attempts',v_job.attempts
    )
  );

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id,
    'replayed',false
  );
end
$$;

revoke all on function public.claim_message_job(uuid)
from public,anon,authenticated;
revoke all on function public.fail_message_attempt(uuid,uuid,text)
from public,anon,authenticated;
revoke all on function public.finish_message_job(uuid,uuid,text,text,text)
from public,anon,authenticated;

grant execute on function public.claim_message_job(uuid)
to service_role,postgres;
grant execute on function public.fail_message_attempt(uuid,uuid,text)
to service_role,postgres;
grant execute on function public.finish_message_job(uuid,uuid,text,text,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_message_job(uuid)','service_role'),
  ('public.fail_message_attempt(uuid,uuid,text)','service_role'),
  ('public.finish_message_job(uuid,uuid,text,text,text)','service_role')
on conflict do nothing;
