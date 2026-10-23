
update public.message_jobs
set state='RECONCILIATION_REQUIRED'
where state='UNKNOWN';

alter table public.message_jobs
  drop constraint if exists message_jobs_state_check;

alter table public.message_jobs
  add constraint message_jobs_state_check
  check(state in (
    'QUEUED','SENDING','SENT','DELIVERED',
    'FAILED','RECONCILIATION_REQUIRED','CANCELLED'
  ));

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

  if old.state='DELIVERED' and new.state<>old.state then
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if old.state='CANCELLED' and new.state<>old.state then
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if old.state='QUEUED' and new.state not in (
    'QUEUED','SENDING','FAILED','CANCELLED'
  ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENDING' and new.state not in (
    'SENDING','QUEUED','SENT','DELIVERED','FAILED',
    'RECONCILIATION_REQUIRED','CANCELLED'
  ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENT' and new.state not in (
    'SENT','DELIVERED','FAILED'
  ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='FAILED' and new.state not in (
    'FAILED','QUEUED','SENDING','DELIVERED','CANCELLED'
  ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='RECONCILIATION_REQUIRED' and new.state not in (
    'RECONCILIATION_REQUIRED','SENT','DELIVERED','FAILED','CANCELLED'
  ) then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  end if;

  if new.attempts>new.max_attempts then
    raise exception 'MESSAGE_ATTEMPT_LIMIT';
  end if;

  if new.state='SENDING'
     and (new.lease_token is null or new.lease_until is null) then
    raise exception 'MESSAGE_LEASE_REQUIRED';
  end if;

  if new.state<>'SENDING' and new.lease_token is not null then
    raise exception 'MESSAGE_LEASE_FORBIDDEN';
  end if;

  return new;
end
$$;

create or replace function public.release_message_job_unknown(
  p_job uuid,
  p_lease uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_job public.message_jobs;
begin
  select * into v_job
  from public.message_jobs
  where id=p_job
  for update;

  if v_job.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_job.state<>'SENDING'
     or p_lease is null
     or p_lease is distinct from v_job.lease_token then
    raise exception 'LEASE_CONFLICT';
  end if;

  update public.message_jobs
  set state='RECONCILIATION_REQUIRED',
      lease_token=null,
      lease_until=null,
      last_error_code='REMOTE_OUTCOME_UNKNOWN',
      updated_at=clock_timestamp()
  where id=p_job
  returning * into v_job;

  perform private.audit(
    'MESSAGE_RECONCILIATION_REQUIRED',
    'message_jobs',
    v_job.id,
    v_job.venue_id,
    null,
    jsonb_build_object(
      'channel',v_job.channel,
      'adapter',v_job.adapter,
      'attempts',v_job.attempts
    )
  );

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'attempts',v_job.attempts
  );
end
$$;

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
  v_res public.reservations;
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

  if v_job.state in (
    'DELIVERED','CANCELLED','SENT','RECONCILIATION_REQUIRED'
  ) then
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'attempts',v_job.attempts
    );
  end if;

  if v_job.reservation_id is not null then
    select * into v_res
    from public.reservations
    where id=v_job.reservation_id;

    if v_res.id is null
       or v_res.status<>'RESERVED'
       or v_res.anonymized_at is not null
       or v_res.walk_in
    then
      update public.message_jobs
      set state='CANCELLED',
          cancelled_at=clock_timestamp(),
          lease_token=null,
          lease_until=null,
          updated_at=clock_timestamp()
      where id=v_job.id;

      return jsonb_build_object(
        'id',v_job.id,
        'state','CANCELLED',
        'reason','RESERVATION_NOT_MESSAGEABLE'
      );
    end if;
  end if;

  if v_job.next_attempt_at>clock_timestamp() then
    raise exception 'MESSAGE_NOT_DUE';
  end if;

  if v_job.lease_until is not null
     and v_job.lease_until>clock_timestamp() then
    raise exception 'MESSAGE_IN_PROGRESS';
  end if;

  if v_job.attempts>=v_job.max_attempts then
    update public.message_jobs
    set state='FAILED',
        failed_at=coalesce(failed_at,clock_timestamp()),
        lease_token=null,
        lease_until=null,
        updated_at=clock_timestamp()
    where id=v_job.id;

    return jsonb_build_object(
      'id',v_job.id,
      'state','FAILED',
      'reason','ATTEMPT_LIMIT'
    );
  end if;

  select * into v_payload
  from private.message_job_payloads
  where job_id=v_job.id;

  if v_payload.job_id is null then
    raise exception 'MESSAGE_PAYLOAD_MISSING';
  end if;

  v_lease:=gen_random_uuid();

  update public.message_jobs
  set state='SENDING',
      lease_token=v_lease,
      lease_until=clock_timestamp()+interval '60 seconds',
      attempts=attempts+1,
      last_error_code=null,
      updated_at=clock_timestamp()
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'id',v_job.id,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'dedupe_key',v_job.dedupe_key,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'lease_token',v_lease,
    'lease_until',v_job.lease_until,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'template_data',v_payload.template_data,
    'body_template',v_payload.body_template,
    'provider_template_ref',v_payload.provider_template_ref
  );
end
$$;

create or replace function public.finish_message_job(
  p_job uuid,
  p_lease uuid,
  p_state text,
  p_provider_message_id text,
  p_event_id text,
  p_error_code text default null
)
returns jsonb
language sql
security definer
set search_path=''
as $$
  select public.finish_message_job(
    p_job,
    p_lease,
    p_provider_message_id,
    p_state,
    p_event_id,
    false,
    p_error_code
  )
$$;

create or replace function public.reconcile_message_job(
  p_job uuid,
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
  v_event private.message_provider_events;
  v_state text:=upper(trim(p_state));
begin
  if p_job is null
     or v_state not in ('SENT','DELIVERED','FAILED')
     or p_event_id is null
     or length(p_event_id) not between 1 and 240
     or (
       p_provider_message_id is not null
       and length(p_provider_message_id) not between 1 and 240
     )
     or (
       p_error_code is not null
       and length(p_error_code) not between 1 and 120
     )
  then
    raise exception 'INVALID_MESSAGE_RECONCILIATION';
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
      'duplicate_event',true
    );
  end if;

  if v_job.state='DELIVERED' then
    return jsonb_build_object(
      'id',v_job.id,
      'state','DELIVERED',
      'late_event_ignored',true
    );
  end if;

  if v_job.state<>'RECONCILIATION_REQUIRED' then
    raise exception 'MESSAGE_NOT_RECONCILABLE';
  end if;

  if v_state in ('SENT','DELIVERED')
     and (
       p_provider_message_id is null
       or length(trim(p_provider_message_id))=0
     )
  then
    raise exception 'PROVIDER_MESSAGE_ID_REQUIRED';
  end if;

  insert into private.message_provider_events(
    adapter,event_id,job_id,state
  ) values(
    v_job.adapter,p_event_id,v_job.id,v_state
  );

  update public.message_jobs
  set state=v_state,
      provider_message_id=coalesce(
        p_provider_message_id,provider_message_id
      ),
      last_error_code=case
        when v_state='FAILED'
          then coalesce(nullif(trim(p_error_code),''),'PROVIDER_FAILED')
        else null
      end,
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
        when v_state='FAILED'
          then coalesce(failed_at,clock_timestamp())
        else failed_at
      end,
      updated_at=clock_timestamp()
  where id=v_job.id
  returning * into v_job;

  perform private.audit(
    'MESSAGE_RECONCILED',
    'message_jobs',
    v_job.id,
    v_job.venue_id,
    null,
    jsonb_build_object(
      'state',v_job.state,
      'channel',v_job.channel,
      'adapter',v_job.adapter,
      'attempts',v_job.attempts
    )
  );

  return jsonb_build_object(
    'id',v_job.id,
    'state',v_job.state,
    'provider_message_id',v_job.provider_message_id,
    'duplicate_event',false
  );
end
$$;

revoke all on function public.reconcile_message_job(
  uuid,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.reconcile_message_job(
  uuid,text,text,text,text
) to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.reconcile_message_job(uuid,text,text,text,text)',
  'service_role'
)
on conflict do nothing;
