
create or replace function private.enqueue_reservation_message(
  p_reservation uuid,
  p_event_type text,
  p_channel text,
  p_scheduled_for timestamptz,
  p_dedupe_key text,
  p_template_override text default null
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_res public.reservations;
  v_setting public.message_provider_settings;
  v_destination text;
  v_template text;
  v_job public.message_jobs;
  v_existing public.message_jobs;
  v_venue_name text;
  v_channel text:=upper(trim(p_channel));
begin
  if p_reservation is null
     or p_event_type not in ('RESERVATION_CONFIRMATION','RESERVATION_REMINDER')
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM')
     or p_scheduled_for is null
     or p_dedupe_key is null
     or length(p_dedupe_key) not between 16 and 240
  then
    raise exception 'INVALID_MESSAGE_REQUEST';
  end if;

  select * into v_res
  from public.reservations
  where id=p_reservation
  for share;

  if v_res.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;

  perform private.require_reservation_message_channel(
    v_res.venue_id,
    v_channel
  );

  if v_res.walk_in
     or v_res.anonymized_at is not null
     or v_res.status<>'RESERVED'
  then
    raise exception 'RESERVATION_NOT_MESSAGEABLE';
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_res.venue_id
    and channel=v_channel
    and enabled;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_CHANNEL_DISABLED';
  end if;

  v_destination:=private.reservation_message_destination(
    p_reservation,v_channel
  );

  if v_destination is null or length(trim(v_destination))<2 then
    raise exception 'MESSAGE_DESTINATION_MISSING';
  end if;

  v_template:=coalesce(
    nullif(trim(p_template_override),''),
    case
      when p_event_type='RESERVATION_CONFIRMATION'
        then v_setting.confirmation_template
      else v_setting.reminder_template
    end
  );

  if v_template is null then
    raise exception 'MESSAGE_TEMPLATE_MISSING';
  end if;

  insert into public.message_jobs(
    venue_id,reservation_id,event_type,channel,adapter,dedupe_key,
    state,scheduled_for,next_attempt_at,attempts,max_attempts
  ) values(
    v_res.venue_id,v_res.id,p_event_type,v_channel,v_setting.adapter,p_dedupe_key,
    'QUEUED',p_scheduled_for,greatest(p_scheduled_for,clock_timestamp()),0,v_setting.max_attempts
  )
  on conflict(dedupe_key) do nothing
  returning * into v_job;

  if v_job.id is null then
    select * into v_existing
    from public.message_jobs
    where dedupe_key=p_dedupe_key;

    if v_existing.reservation_id<>p_reservation
       or v_existing.event_type<>p_event_type
       or v_existing.channel<>v_channel
       or v_existing.scheduled_for<>p_scheduled_for
    then
      raise exception 'MESSAGE_DEDUPE_MISMATCH';
    end if;

    return v_existing.id;
  end if;

  select name into v_venue_name
  from public.venues
  where id=v_res.venue_id;

  insert into private.message_job_payloads(
    job_id,destination,locale,template_key,template_data,
    body_template,provider_template_ref
  ) values(
    v_job.id,
    trim(v_destination),
    'it-IT',
    v_template,
    jsonb_build_object(
      'reservation_id',v_res.id,
      'first_name',v_res.first_name,
      'last_name',v_res.last_name,
      'service_date',v_res.service_date,
      'slot_time',v_res.slot_time,
      'party_size',v_res.party_size,
      'venue_name',v_venue_name
    ),
    null,
    v_template
  );

  return v_job.id;
end
$$;
