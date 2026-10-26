
create or replace function private.message_retry_delay_seconds(
  p_venue uuid,
  p_channel text,
  p_attempts integer
)
returns integer
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_base integer;
  v_max integer;
begin
  select base_backoff_seconds,max_backoff_seconds
  into v_base,v_max
  from public.message_provider_settings
  where venue_id=p_venue
    and channel=p_channel;

  v_base:=coalesce(v_base,30);
  v_max:=coalesce(v_max,1800);

  return least(
    v_max,
    greatest(v_base, v_base*(2^greatest(0,least(coalesce(p_attempts,1)-1,10)))::integer)
  );
end
$$;

revoke all on function private.message_retry_delay_seconds(uuid,text,integer)
from public,anon,authenticated;

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
  v_lease uuid;
begin
  if p_job is null then
    raise exception 'INVALID_MESSAGE_JOB';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_job.state in ('DELIVERED','CANCELLED') then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'terminal',true
    );
  end if;

  if v_job.state='SENT' then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'terminal',false,
      'awaiting_delivery_event',true,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts then
    return jsonb_build_object(
      'id',v_job.id,
      'state','FAILED',
      'terminal',true,
      'attempts',v_job.attempts,
      'max_attempts',v_job.max_attempts
    );
  end if;

  if v_job.next_attempt_at>clock_timestamp() then
    raise exception 'MESSAGE_NOT_DUE';
  end if;

  if v_job.lease_until is not null
     and v_job.lease_until>clock_timestamp() then
    raise exception 'MESSAGE_IN_PROGRESS';
  end if;

  v_lease:=gen_random_uuid();

  update public.message_jobs
  set state='SENDING',
      lease_token=v_lease,
      lease_until=clock_timestamp()+interval '45 seconds',
      attempts=attempts+1,
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

  select * into v_payload
  from private.message_job_payloads
  where job_id=v_job.id;

  if v_payload.job_id is null then
    raise exception 'MESSAGE_PAYLOAD_MISSING';
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'dedupe_key',v_job.dedupe_key,
    'attempts',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
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
  p_provider_message_id text,
  p_state text,
  p_event_id text,
  p_retryable boolean default false,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_event private.message_provider_events;
  v_state text:=upper(trim(p_state));
  v_delay integer;
  v_final_state text;
  v_next timestamptz;
begin
  if p_job is null
     or p_lease is null
     or v_state not in ('SENT','DELIVERED','FAILED')
     or p_event_id is null
     or length(p_event_id) not between 1 and 240
     or (p_provider_message_id is not null and length(p_provider_message_id) not between 1 and 240)
     or (p_error_code is not null and length(p_error_code) not between 1 and 120)
  then
    raise exception 'INVALID_MESSAGE_RESULT';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_event
  from private.message_provider_events
  where adapter=v_job.adapter
    and event_id=p_event_id;

  if v_event.event_id is not null then
    if v_event.job_id<>v_job.id
       or v_event.state<>v_state then
      raise exception 'MESSAGE_PROVIDER_EVENT_MISMATCH';
    end if;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id,
      'duplicate_event',true
    );
  end if;

  if v_job.state<>'SENDING'
     or v_job.lease_token is distinct from p_lease
     or v_job.lease_until is null
  then
    raise exception 'MESSAGE_LEASE_CONFLICT';
  end if;

  if v_state in ('SENT','DELIVERED')
     and (p_provider_message_id is null or length(trim(p_provider_message_id))=0) then
    raise exception 'PROVIDER_MESSAGE_ID_REQUIRED';
  end if;

  if v_job.provider_message_id is not null
     and p_provider_message_id is not null
     and v_job.provider_message_id<>p_provider_message_id then
    raise exception 'PROVIDER_MESSAGE_ID_MISMATCH';
  end if;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state
  ) values(
    v_job.adapter,p_event_id,v_job.id,v_state
  );

  if v_state='FAILED'
     and coalesce(p_retryable,false)
     and v_job.attempts<v_job.max_attempts then
    v_delay:=private.message_retry_delay_seconds(
      v_job.venue_id,v_job.channel,v_job.attempts
    );
    v_final_state:='QUEUED';
    v_next:=clock_timestamp()+make_interval(secs=>v_delay);
  else
    v_final_state:=v_state;
    v_next:=v_job.next_attempt_at;
  end if;

  update public.message_jobs
  set state=v_final_state,
      provider_message_id=coalesce(p_provider_message_id,provider_message_id),
      lease_token=null,
      lease_until=null,
      last_error_code=case
        when v_state='FAILED' then coalesce(nullif(trim(p_error_code),''),'PROVIDER_FAILED')
        else null
      end,
      next_attempt_at=v_next,
      sent_at=case
        when v_state in ('SENT','DELIVERED') then coalesce(sent_at,clock_timestamp())
        else sent_at
      end,
      delivered_at=case
        when v_state='DELIVERED' then coalesce(delivered_at,clock_timestamp())
        else delivered_at
      end,
      failed_at=case
        when v_state='FAILED' and v_final_state='FAILED' then coalesce(failed_at,clock_timestamp())
        else failed_at
      end
  where id=v_job.id
  returning * into v_job;

  perform private.audit(
    'MESSAGE_PROVIDER_RESULT',
    'message_jobs',
    v_job.id,
    v_job.venue_id,
    null,
    jsonb_build_object(
      'state',v_state,
      'stored_state',v_job.state,
      'channel',v_job.channel,
      'adapter',v_job.adapter,
      'attempts',v_job.attempts,
      'retryable',coalesce(p_retryable,false),
      'error_code',p_error_code
    )
  );

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id,
    'attempts',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'duplicate_event',false
  );
end
$$;

create or replace function public.release_message_lease(
  p_job uuid,
  p_lease uuid,
  p_error_code text default 'REMOTE_OUTCOME_UNKNOWN'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
  v_delay integer;
begin
  if p_job is null
     or p_lease is null
     or p_error_code is null
     or length(trim(p_error_code)) not between 1 and 120 then
    raise exception 'INVALID_MESSAGE_RELEASE';
  end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  if v_job.state<>'SENDING'
     or v_job.lease_token is distinct from p_lease then
    raise exception 'MESSAGE_LEASE_CONFLICT';
  end if;

  if v_job.attempts>=v_job.max_attempts then
    update public.message_jobs
    set state='FAILED',
        lease_token=null,
        lease_until=null,
        last_error_code=left(trim(p_error_code),120),
        failed_at=coalesce(failed_at,clock_timestamp())
    where id=v_job.id
    returning * into v_job;
  else
    v_delay:=private.message_retry_delay_seconds(
      v_job.venue_id,v_job.channel,v_job.attempts
    );

    update public.message_jobs
    set state='QUEUED',
        lease_token=null,
        lease_until=null,
        last_error_code=left(trim(p_error_code),120),
        next_attempt_at=clock_timestamp()+make_interval(secs=>v_delay)
    where id=v_job.id
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'last_error_code',v_job.last_error_code
  );
end
$$;

revoke all on function public.claim_message_job(uuid)
from public,anon,authenticated;
grant execute on function public.claim_message_job(uuid)
to service_role,postgres;

revoke all on function public.finish_message_job(
  uuid,uuid,text,text,text,boolean,text
) from public,anon,authenticated;
grant execute on function public.finish_message_job(
  uuid,uuid,text,text,text,boolean,text
) to service_role,postgres;

revoke all on function public.release_message_lease(uuid,uuid,text)
from public,anon,authenticated;
grant execute on function public.release_message_lease(uuid,uuid,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_message_job(uuid)','service_role'),
  ('public.finish_message_job(uuid,uuid,text,text,text,boolean,text)','service_role'),
  ('public.release_message_lease(uuid,uuid,text)','service_role')
on conflict do nothing;
