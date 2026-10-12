
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

  if v_job.state in ('DELIVERED','CANCELLED','SENT','UNKNOWN') then
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

revoke all on function public.claim_message_job(uuid)
from public,anon,authenticated;
grant execute on function public.claim_message_job(uuid)
to service_role,postgres;
