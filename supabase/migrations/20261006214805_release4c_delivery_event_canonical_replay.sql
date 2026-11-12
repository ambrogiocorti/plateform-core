
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
    return jsonb_build_object(
      'id',v_job.id,
      'state',v_job.state,
      'provider_message_id',v_job.provider_message_id
    );
  end if;

  if v_job.state='CANCELLED' then
    return jsonb_build_object(
      'id',v_job.id,
      'state','CANCELLED',
      'provider_message_id',v_job.provider_message_id
    );
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
