
alter table public.message_provider_settings
  add column if not exists unknown_outcome_policy text not null default 'RECONCILE'
    check(unknown_outcome_policy in ('RECONCILE','AUTO_RETRY'));

alter table public.message_jobs
  drop constraint if exists message_jobs_state_check;

alter table public.message_jobs
  add constraint message_jobs_state_check
  check(state in (
    'QUEUED','SENDING','SENT','DELIVERED','FAILED','CANCELLED','RECONCILIATION_REQUIRED'
  ));

alter table private.message_provider_events
  add column if not exists provider_message_id text,
  add column if not exists error_code text;

alter table private.message_provider_events
  drop constraint if exists message_provider_events_provider_id_check,
  add constraint message_provider_events_provider_id_check
    check(provider_message_id is null or length(provider_message_id) between 1 and 240),
  drop constraint if exists message_provider_events_error_code_check,
  add constraint message_provider_events_error_code_check
    check(error_code is null or length(error_code) between 1 and 120);

drop trigger if exists immutable_event on private.message_provider_events;
create trigger immutable_event
before update or delete on private.message_provider_events
for each row execute function private.immutable_record();

create or replace function private.guard_message_job()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' or tg_op='TRUNCATE' then
    raise exception 'IMMUTABLE_MESSAGE_JOB';
  end if;

  if (
    to_jsonb(new)
      - array[
        'state','next_attempt_at','attempts','lease_token','lease_until',
        'provider_message_id','last_error_code','sent_at','delivered_at',
        'failed_at','cancelled_at','version','updated_at'
      ]
  ) is distinct from (
    to_jsonb(old)
      - array[
        'state','next_attempt_at','attempts','lease_token','lease_until',
        'provider_message_id','last_error_code','sent_at','delivered_at',
        'failed_at','cancelled_at','version','updated_at'
      ]
  ) then
    raise exception 'IMMUTABLE_MESSAGE_JOB';
  end if;

  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception 'IMMUTABLE_PROVIDER_MESSAGE_ID';
  end if;

  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'IMMUTABLE_SENT_AT';
  end if;

  if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
    raise exception 'IMMUTABLE_DELIVERED_AT';
  end if;

  if old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at then
    raise exception 'IMMUTABLE_CANCELLED_AT';
  end if;

  if old.state in ('DELIVERED','CANCELLED') and new.state<>old.state then
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if old.state='RECONCILIATION_REQUIRED' and new.state<>old.state then
    raise exception 'MESSAGE_RECONCILIATION_REQUIRED';
  end if;

  if old.state='QUEUED'
     and new.state not in ('QUEUED','SENDING','FAILED','CANCELLED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENDING'
     and new.state not in (
       'SENDING','SENT','FAILED','CANCELLED','RECONCILIATION_REQUIRED'
     ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENT'
     and new.state not in ('SENT','DELIVERED','FAILED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='FAILED'
     and new.state not in ('FAILED','QUEUED','SENDING','CANCELLED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  end if;

  if new.attempts>new.max_attempts then
    raise exception 'MESSAGE_ATTEMPT_LIMIT';
  end if;

  if new.state='SENDING' and (new.lease_token is null or new.lease_until is null) then
    raise exception 'MESSAGE_LEASE_REQUIRED';
  end if;

  if new.state<>'SENDING' and new.lease_token is not null then
    raise exception 'MESSAGE_LEASE_FORBIDDEN';
  end if;

  return new;
end
$$;

create or replace function private.message_backoff_seconds(
  p_attempts integer,
  p_base integer,
  p_max integer
)
returns integer
language sql
immutable
set search_path=''
as $$
  select least(
    p_max,
    greatest(
      p_base,
      p_base * (2 ^ greatest(0,least(coalesce(p_attempts,1)-1,10)))::integer
    )
  )
$$;

revoke all on function private.message_backoff_seconds(integer,integer,integer)
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
  v_setting public.message_provider_settings;
begin
  if p_job is null then raise exception 'INVALID_MESSAGE_JOB'; end if;

  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then raise exception 'NOT_FOUND'; end if;

  if v_job.state in ('DELIVERED','CANCELLED','RECONCILIATION_REQUIRED') then
    return jsonb_build_object('id',v_job.id,'state',v_job.state);
  end if;

  if v_job.state='SENT' then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts then
    return jsonb_build_object('id',v_job.id,'state','FAILED','terminal',true);
  end if;

  if v_job.next_attempt_at>clock_timestamp() then
    raise exception 'MESSAGE_NOT_DUE';
  end if;

  if v_job.lease_until>clock_timestamp() then
    raise exception 'MESSAGE_IN_PROGRESS';
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
      lease_until=clock_timestamp()+interval '45 seconds',
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
    'provider_idempotency_key',v_job.id,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'unknown_outcome_policy',v_setting.unknown_outcome_policy,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'template_data',v_payload.template_data
  );
end
$$;

create or replace function public.finish_message_send(
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
  v_setting public.message_provider_settings;
  v_existing private.message_provider_events;
  v_state text:=upper(trim(p_state));
  v_backoff integer;
begin
  if p_job is null
     or p_lease is null
     or v_state not in ('SENT','FAILED')
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
       or v_existing.state<>v_state
       or v_existing.provider_message_id is distinct from p_provider_message_id
       or v_existing.error_code is distinct from p_error_code
    then
      raise exception 'MESSAGE_EVENT_MISMATCH';
    end if;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if v_job.state<>'SENDING'
     or v_job.lease_token is distinct from p_lease
     or v_job.lease_until<clock_timestamp()
  then
    raise exception 'MESSAGE_LEASE_CONFLICT';
  end if;

  if v_state='SENT' and p_provider_message_id is null then
    raise exception 'PROVIDER_MESSAGE_ID_REQUIRED';
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_job.venue_id
    and channel=v_job.channel;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state,provider_message_id,error_code
  ) values(
    v_job.adapter,p_event_id,v_job.id,v_state,p_provider_message_id,p_error_code
  );

  if v_state='SENT' then
    update public.message_jobs
    set state='SENT',
        provider_message_id=coalesce(provider_message_id,p_provider_message_id),
        sent_at=coalesce(sent_at,clock_timestamp()),
        lease_token=null,
        lease_until=null,
        last_error_code=null
    where id=v_job.id
    returning * into v_job;
  else
    v_backoff:=private.message_backoff_seconds(
      v_job.attempts,
      v_setting.base_backoff_seconds,
      v_setting.max_backoff_seconds
    );

    update public.message_jobs
    set state='FAILED',
        lease_token=null,
        lease_until=null,
        last_error_code=coalesce(p_error_code,'PROVIDER_SEND_FAILED'),
        next_attempt_at=clock_timestamp()+make_interval(secs=>v_backoff),
        failed_at=case when attempts>=max_attempts then clock_timestamp() else null end
    where id=v_job.id
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id,
    'attempts',v_job.attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'terminal',(v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts)
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
  v_setting public.message_provider_settings;
  v_backoff integer;
begin
  if p_job is null
     or p_lease is null
     or p_error_code is null
     or length(p_error_code) not between 1 and 120
  then
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

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_job.venue_id
    and channel=v_job.channel;

  if v_setting.unknown_outcome_policy='AUTO_RETRY' then
    v_backoff:=private.message_backoff_seconds(
      v_job.attempts,
      v_setting.base_backoff_seconds,
      v_setting.max_backoff_seconds
    );

    update public.message_jobs
    set state='FAILED',
        lease_token=null,
        lease_until=null,
        last_error_code=p_error_code,
        next_attempt_at=clock_timestamp()+make_interval(secs=>v_backoff),
        failed_at=case when attempts>=max_attempts then clock_timestamp() else null end
    where id=v_job.id
    returning * into v_job;
  else
    update public.message_jobs
    set state='RECONCILIATION_REQUIRED',
        lease_token=null,
        lease_until=null,
        last_error_code=p_error_code
    where id=v_job.id
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'last_error_code',v_job.last_error_code,
    'next_attempt_at',v_job.next_attempt_at
  );
end
$$;

create or replace function public.apply_message_delivery_event(
  p_adapter text,
  p_event_id text,
  p_provider_message_id text,
  p_state text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_adapter text:=upper(trim(p_adapter));
  v_state text:=upper(trim(p_state));
  v_job public.message_jobs;
  v_existing private.message_provider_events;
  v_setting public.message_provider_settings;
  v_backoff integer;
begin
  if v_adapter not in ('TWILIO','TELEGRAM','MOCK')
     or p_event_id is null
     or length(p_event_id) not between 1 and 240
     or p_provider_message_id is null
     or length(p_provider_message_id) not between 1 and 240
     or v_state not in ('DELIVERED','FAILED')
     or (p_error_code is not null and length(p_error_code) not between 1 and 120)
  then
    raise exception 'INVALID_DELIVERY_EVENT';
  end if;

  select * into v_existing
  from private.message_provider_events
  where adapter=v_adapter
    and event_id=p_event_id;

  if v_existing.event_id is not null then
    if v_existing.provider_message_id is distinct from p_provider_message_id
       or v_existing.state<>v_state
       or v_existing.error_code is distinct from p_error_code
    then
      raise exception 'MESSAGE_EVENT_MISMATCH';
    end if;

    select * into v_job
    from public.message_jobs
    where id=v_existing.job_id;

    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  select * into v_job
  from public.message_jobs
  where adapter=v_adapter
    and provider_message_id=p_provider_message_id
  for update;

  if v_job.id is null then raise exception 'MESSAGE_JOB_NOT_FOUND'; end if;

  if v_job.state not in ('SENT','FAILED') then
    raise exception 'INVALID_MESSAGE_DELIVERY_STATE';
  end if;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state,provider_message_id,error_code
  ) values(
    v_adapter,p_event_id,v_job.id,v_state,p_provider_message_id,p_error_code
  );

  if v_state='DELIVERED' then
    update public.message_jobs
    set state='DELIVERED',
        delivered_at=coalesce(delivered_at,clock_timestamp()),
        last_error_code=null
    where id=v_job.id
    returning * into v_job;
  else
    select * into v_setting
    from public.message_provider_settings
    where venue_id=v_job.venue_id
      and channel=v_job.channel;

    v_backoff:=private.message_backoff_seconds(
      v_job.attempts,
      v_setting.base_backoff_seconds,
      v_setting.max_backoff_seconds
    );

    update public.message_jobs
    set state='FAILED',
        last_error_code=coalesce(p_error_code,'PROVIDER_DELIVERY_FAILED'),
        next_attempt_at=clock_timestamp()+make_interval(secs=>v_backoff),
        failed_at=case when attempts>=max_attempts then clock_timestamp() else null end
    where id=v_job.id
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id,
    'attempts',v_job.attempts,
    'next_attempt_at',v_job.next_attempt_at,
    'terminal',(v_job.state='FAILED' and v_job.attempts>=v_job.max_attempts)
  );
end
$$;

revoke all on function public.claim_message_job(uuid)
from public,anon,authenticated;
revoke all on function public.finish_message_send(uuid,uuid,text,text,text,text)
from public,anon,authenticated;
revoke all on function public.release_message_lease(uuid,uuid,text)
from public,anon,authenticated;
revoke all on function public.apply_message_delivery_event(text,text,text,text,text)
from public,anon,authenticated;

grant execute on function public.claim_message_job(uuid)
to service_role,postgres;
grant execute on function public.finish_message_send(uuid,uuid,text,text,text,text)
to service_role,postgres;
grant execute on function public.release_message_lease(uuid,uuid,text)
to service_role,postgres;
grant execute on function public.apply_message_delivery_event(text,text,text,text,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_message_job(uuid)','service_role'),
  ('public.finish_message_send(uuid,uuid,text,text,text,text)','service_role'),
  ('public.release_message_lease(uuid,uuid,text)','service_role'),
  ('public.apply_message_delivery_event(text,text,text,text,text)','service_role')
on conflict do nothing;
