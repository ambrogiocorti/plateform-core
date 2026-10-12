create or replace function private.message_retry_delay_seconds(
  p_job public.message_jobs
)
returns integer
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_setting public.message_provider_settings;
  v_base integer;
  v_max integer;
begin
  select * into v_setting
  from public.message_provider_settings
  where venue_id=p_job.venue_id
    and channel=p_job.channel;

  v_base:=coalesce(v_setting.base_backoff_seconds,30);
  v_max:=coalesce(v_setting.max_backoff_seconds,1800);

  return least(
    v_max,
    greatest(
      v_base,
      v_base * (2 ^ greatest(0,least(p_job.attempts-1,10)))::integer
    )
  );
end
$$;

revoke all on function private.message_retry_delay_seconds(public.message_jobs)
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
  if p_job is null then raise exception 'INVALID_MESSAGE_JOB'; end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  if v_job.state in ('DELIVERED','CANCELLED') then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'attempts',v_job.attempts
    );
  end if;

  if v_job.state='SENT' then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'attempts',v_job.attempts,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if v_job.scheduled_for>clock_timestamp()
     or v_job.next_attempt_at>clock_timestamp() then
    raise exception 'MESSAGE_NOT_DUE';
  end if;

  if v_job.state='SENDING' and v_job.lease_until>clock_timestamp() then
    raise exception 'MESSAGE_IN_PROGRESS';
  end if;

  if v_job.attempts>=v_job.max_attempts then
    if v_job.state<>'FAILED' or v_job.failed_at is null then
      update public.message_jobs
      set state='FAILED',
          failed_at=coalesce(failed_at,clock_timestamp()),
          lease_token=null,
          lease_until=null,
          last_error_code=coalesce(last_error_code,'MAX_ATTEMPTS_REACHED')
      where id=v_job.id
      returning * into v_job;
    end if;

    return jsonb_build_object(
      'id',v_job.id,
      'state','FAILED',
      'attempts',v_job.attempts,
      'terminal',true
    );
  end if;

  v_lease:=gen_random_uuid();

  update public.message_jobs
  set state='SENDING',
      lease_token=v_lease,
      lease_until=clock_timestamp()+interval '60 seconds',
      attempts=attempts+1,
      last_error_code=null,
      failed_at=null
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
    'lease_token',v_lease,
    'lease_until',v_job.lease_until,
    'attempts',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'adapter',v_job.adapter,
    'channel',v_job.channel,
    'event_type',v_job.event_type,
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
  p_error_code text default null
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
  v_delay integer;
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

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  select * into v_existing
  from private.message_provider_events
  where adapter=v_job.adapter
    and event_id=p_event_id;

  if v_existing.event_id is not null then
    if v_existing.job_id<>v_job.id
       or v_existing.state<>v_state then
      raise exception 'MESSAGE_PROVIDER_EVENT_MISMATCH';
    end if;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id,
      'duplicate_event',true
    );
  end if;

  if v_job.state='DELIVERED' then
    if v_state='DELIVERED' then
      insert into private.message_provider_events(adapter,event_id,job_id,state)
      values(v_job.adapter,p_event_id,v_job.id,v_state);

      return jsonb_build_object(
        'id',v_job.id,
        'state','DELIVERED',
        'provider_message_id',v_job.provider_message_id
      );
    end if;
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if v_job.state<>'SENDING' then
    raise exception 'MESSAGE_NOT_IN_FLIGHT';
  end if;

  if v_job.lease_token is distinct from p_lease then
    raise exception 'MESSAGE_LEASE_CONFLICT';
  end if;

  if v_state in ('SENT','DELIVERED')
     and (p_provider_message_id is null or length(trim(p_provider_message_id))=0) then
    raise exception 'PROVIDER_MESSAGE_ID_REQUIRED';
  end if;

  if v_job.provider_message_id is not null
     and p_provider_message_id is distinct from v_job.provider_message_id then
    raise exception 'PROVIDER_MESSAGE_ID_MISMATCH';
  end if;

  insert into private.message_provider_events(adapter,event_id,job_id,state)
  values(v_job.adapter,p_event_id,v_job.id,v_state);

  if v_state='FAILED' then
    v_delay:=private.message_retry_delay_seconds(v_job);

    update public.message_jobs
    set state='FAILED',
        provider_message_id=coalesce(provider_message_id,p_provider_message_id),
        lease_token=null,
        lease_until=null,
        last_error_code=coalesce(nullif(trim(p_error_code),''),'PROVIDER_FAILED'),
        next_attempt_at=case
          when attempts>=max_attempts then next_attempt_at
          else clock_timestamp()+make_interval(secs=>v_delay)
        end,
        failed_at=case
          when attempts>=max_attempts then clock_timestamp()
          else null
        end
    where id=v_job.id
    returning * into v_job;
  elsif v_state='SENT' then
    update public.message_jobs
    set state='SENT',
        provider_message_id=p_provider_message_id,
        lease_token=null,
        lease_until=null,
        last_error_code=null,
        sent_at=coalesce(sent_at,clock_timestamp())
    where id=v_job.id
    returning * into v_job;
  else
    update public.message_jobs
    set state='DELIVERED',
        provider_message_id=p_provider_message_id,
        lease_token=null,
        lease_until=null,
        last_error_code=null,
        sent_at=coalesce(sent_at,clock_timestamp()),
        delivered_at=coalesce(delivered_at,clock_timestamp())
    where id=v_job.id
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'provider_message_id',v_job.provider_message_id,
    'terminal',v_job.state in ('DELIVERED','CANCELLED') or (v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts)
  );
end
$$;

create or replace function public.release_message_job_lease(
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

  v_delay:=private.message_retry_delay_seconds(v_job);

  update public.message_jobs
  set state='FAILED',
      lease_token=null,
      lease_until=null,
      last_error_code=trim(p_error_code),
      next_attempt_at=case
        when attempts>=max_attempts then next_attempt_at
        else clock_timestamp()+make_interval(secs=>v_delay)
      end,
      failed_at=case
        when attempts>=max_attempts then clock_timestamp()
        else null
      end
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'terminal',v_job.attempts>=v_job.max_attempts
  );
end
$$;

revoke all on function public.claim_message_job(uuid)
from public,anon,authenticated;
revoke all on function public.finish_message_job(uuid,uuid,text,text,text,text)
from public,anon,authenticated;
revoke all on function public.release_message_job_lease(uuid,uuid,text)
from public,anon,authenticated;

grant execute on function public.claim_message_job(uuid)
to service_role,postgres;
grant execute on function public.finish_message_job(uuid,uuid,text,text,text,text)
to service_role,postgres;
grant execute on function public.release_message_job_lease(uuid,uuid,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_message_job(uuid)','service_role'),
  ('public.finish_message_job(uuid,uuid,text,text,text,text)','service_role'),
  ('public.release_message_job_lease(uuid,uuid,text)','service_role')
on conflict do nothing;