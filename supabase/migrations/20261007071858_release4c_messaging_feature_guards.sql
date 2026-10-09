
create or replace function private.require_reservation_message_channel(
  p_venue uuid,
  p_channel text
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_channel text:=upper(trim(p_channel));
begin
  perform private.require_venue_feature(
    p_venue,
    'RESERVATION_MESSAGING'
  );

  if v_channel in ('WHATSAPP','SMS','TELEGRAM') then
    perform private.require_venue_feature(
      p_venue,
      'WHATSAPP_TELEGRAM_SMS_MESSAGING'
    );
  else
    raise exception 'UNSUPPORTED_MESSAGE_CHANNEL';
  end if;
end
$$;

revoke all on function private.require_reservation_message_channel(uuid,text)
from public,anon,authenticated;

create or replace function private.reservation_message_event()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.walk_in
     or new.anonymized_at is not null
     or new.status<>'RESERVED'
     or (
       tg_op='UPDATE'
       and old.status is not distinct from new.status
     )
     or not private.venue_feature_enabled(
       new.venue_id,
       'RESERVATION_MESSAGING'
     )
  then
    return new;
  end if;

  insert into private.reservation_message_outbox(
    reservation_id,venue_id,event_type,event_key,next_attempt_at
  ) values(
    new.id,
    new.venue_id,
    'RESERVATION_CONFIRMED',
    'reservation-confirmed:'||new.id::text,
    clock_timestamp()
  )
  on conflict(event_key) do nothing;

  return new;
end
$$;

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
    job_id,destination,locale,template_key,template_data
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
    )
  );

  return v_job.id;
end
$$;

create or replace function public.save_message_provider_setting(
  p_venue uuid,
  p_channel text,
  p_adapter text,
  p_enabled boolean,
  p_sender_ref text,
  p_confirmation_template text,
  p_reminder_template text,
  p_max_attempts integer,
  p_base_backoff_seconds integer,
  p_max_backoff_seconds integer,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_channel text:=upper(trim(p_channel));
  v_adapter text:=upper(trim(p_adapter));
  v_result jsonb;
  v_row public.message_provider_settings;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_reservation_message_channel(p_venue,v_channel);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM')
     or v_adapter not in ('TWILIO','TELEGRAM','MOCK')
     or p_enabled is null
     or p_max_attempts not between 1 and 10
     or p_base_backoff_seconds not between 5 and 3600
     or p_max_backoff_seconds not between 30 and 21600
     or p_max_backoff_seconds<p_base_backoff_seconds
     or (p_sender_ref is not null and length(trim(p_sender_ref)) not between 1 and 200)
     or (p_confirmation_template is not null and length(trim(p_confirmation_template)) not between 1 and 160)
     or (p_reminder_template is not null and length(trim(p_reminder_template)) not between 1 and 160)
     or (v_channel='TELEGRAM' and v_adapter not in ('TELEGRAM','MOCK'))
     or (v_channel in ('WHATSAPP','SMS') and v_adapter not in ('TWILIO','MOCK'))
  then
    raise exception 'INVALID_MESSAGE_PROVIDER_SETTING';
  end if;

  if p_enabled and (
    (v_channel='TELEGRAM' and v_adapter='TELEGRAM' and nullif(trim(p_sender_ref),'') is null)
    or p_confirmation_template is null
    or p_reminder_template is null
  ) then
    raise exception 'MESSAGE_PROVIDER_CONFIGURATION_INCOMPLETE';
  end if;

  v_result:=private.idempotency_begin(
    'message_provider_setting',
    p_key,
    jsonb_build_object(
      'venue',p_venue,'channel',v_channel,'adapter',v_adapter,
      'enabled',p_enabled,'sender_ref',nullif(trim(p_sender_ref),''),
      'confirmation_template',nullif(trim(p_confirmation_template),''),
      'reminder_template',nullif(trim(p_reminder_template),''),
      'max_attempts',p_max_attempts,
      'base_backoff_seconds',p_base_backoff_seconds,
      'max_backoff_seconds',p_max_backoff_seconds,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  select * into v_row
  from public.message_provider_settings
  where venue_id=p_venue and channel=v_channel
  for update;

  if v_row.venue_id is null then
    if p_version is not null then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    insert into public.message_provider_settings(
      venue_id,channel,adapter,enabled,sender_ref,
      confirmation_template,reminder_template,
      max_attempts,base_backoff_seconds,max_backoff_seconds
    ) values(
      p_venue,v_channel,v_adapter,p_enabled,nullif(trim(p_sender_ref),''),
      nullif(trim(p_confirmation_template),''),
      nullif(trim(p_reminder_template),''),
      p_max_attempts,p_base_backoff_seconds,p_max_backoff_seconds
    )
    returning * into v_row;
  else
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.message_provider_settings
    set adapter=v_adapter,
        enabled=p_enabled,
        sender_ref=nullif(trim(p_sender_ref),''),
        confirmation_template=nullif(trim(p_confirmation_template),''),
        reminder_template=nullif(trim(p_reminder_template),''),
        max_attempts=p_max_attempts,
        base_backoff_seconds=p_base_backoff_seconds,
        max_backoff_seconds=p_max_backoff_seconds
    where venue_id=p_venue and channel=v_channel
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'venue_id',v_row.venue_id,'channel',v_row.channel,
    'adapter',v_row.adapter,'enabled',v_row.enabled,'version',v_row.version
  );

  return private.idempotency_finish('message_provider_setting',p_key,v_result);
end
$$;

create or replace function public.save_reservation_reminder_rule(
  p_id uuid,
  p_venue uuid,
  p_channel text,
  p_offset_minutes integer,
  p_template_key text,
  p_active boolean,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_channel text:=upper(trim(p_channel));
  v_result jsonb;
  v_row public.reservation_reminder_rules;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_reservation_message_channel(p_venue,v_channel);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM')
     or p_offset_minutes not between 15 and 20160
     or p_active is null
     or (p_template_key is not null and length(trim(p_template_key)) not between 1 and 160)
  then
    raise exception 'INVALID_REMINDER_RULE';
  end if;

  if not exists(
    select 1
    from public.message_provider_settings s
    where s.venue_id=p_venue
      and s.channel=v_channel
  ) then
    raise exception 'MESSAGE_PROVIDER_SETTING_REQUIRED';
  end if;

  v_result:=private.idempotency_begin(
    'reservation_reminder_rule',
    p_key,
    jsonb_build_object(
      'id',p_id,'venue',p_venue,'channel',v_channel,
      'offset_minutes',p_offset_minutes,
      'template_key',nullif(trim(p_template_key),''),
      'active',p_active,'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.reservation_reminder_rules(
      id,venue_id,channel,offset_minutes,template_key,active
    ) values(
      v_id,p_venue,v_channel,p_offset_minutes,
      nullif(trim(p_template_key),''),p_active
    )
    returning * into v_row;
  else
    select * into v_row
    from public.reservation_reminder_rules
    where id=p_id
    for update;

    if v_row.id is null then raise exception 'NOT_FOUND'; end if;
    if v_row.venue_id<>p_venue then
      raise exception 'VENUE_FORBIDDEN' using errcode='42501';
    end if;
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.reservation_reminder_rules
    set channel=v_channel,offset_minutes=p_offset_minutes,
        template_key=nullif(trim(p_template_key),''),active=p_active
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,'venue_id',v_row.venue_id,'channel',v_row.channel,
    'offset_minutes',v_row.offset_minutes,'active',v_row.active,'version',v_row.version
  );

  return private.idempotency_finish('reservation_reminder_rule',p_key,v_result);
end
$$;
