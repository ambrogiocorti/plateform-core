
create or replace function private.enqueue_reservation_message(
  p_reservation uuid,
  p_event_type text,
  p_channel text,
  p_scheduled_for timestamptz,
  p_dedupe_key text,
  p_template_override text default null
)
returns uuid
language sql
security definer
set search_path=''
as $$
  select private.enqueue_reservation_message(
    p_reservation,
    p_event_type,
    upper(trim(p_channel)),
    p_scheduled_for,
    p_dedupe_key,
    p_template_override,
    null
  )
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
  v_confirmation text:=nullif(trim(p_confirmation_template),'');
  v_reminder text:=nullif(trim(p_reminder_template),'');
  v_result jsonb;
  v_row public.message_provider_settings;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_message_channel(p_venue,v_channel);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM','EMAIL')
     or v_adapter not in ('TWILIO','TELEGRAM','RESEND','MOCK')
     or p_enabled is null
     or p_max_attempts not between 1 and 10
     or p_base_backoff_seconds not between 5 and 3600
     or p_max_backoff_seconds not between 30 and 21600
     or p_max_backoff_seconds<p_base_backoff_seconds
     or (p_sender_ref is not null and length(trim(p_sender_ref)) not between 1 and 200)
     or (v_confirmation is not null and length(v_confirmation) not between 1 and 160)
     or (v_reminder is not null and length(v_reminder) not between 1 and 160)
     or (v_channel='TELEGRAM' and v_adapter not in ('TELEGRAM','MOCK'))
     or (v_channel in ('WHATSAPP','SMS') and v_adapter not in ('TWILIO','MOCK'))
     or (v_channel='EMAIL' and v_adapter not in ('RESEND','MOCK'))
  then
    raise exception 'INVALID_MESSAGE_PROVIDER_SETTING';
  end if;

  if p_enabled and (
    v_confirmation is null
    or v_reminder is null
    or (
      v_channel='TELEGRAM'
      and v_adapter='TELEGRAM'
      and nullif(trim(p_sender_ref),'') is null
    )
    or not exists(
      select 1
      from public.message_templates t
      where t.venue_id=p_venue
        and t.channel=v_channel
        and t.template_key=v_confirmation
        and t.active
    )
    or not exists(
      select 1
      from public.message_templates t
      where t.venue_id=p_venue
        and t.channel=v_channel
        and t.template_key=v_reminder
        and t.active
    )
  ) then
    raise exception 'MESSAGE_PROVIDER_CONFIGURATION_INCOMPLETE';
  end if;

  v_result:=private.idempotency_begin(
    'message_provider_setting',
    p_key,
    jsonb_build_object(
      'venue',p_venue,
      'channel',v_channel,
      'adapter',v_adapter,
      'enabled',p_enabled,
      'sender_ref',nullif(trim(p_sender_ref),''),
      'confirmation_template',v_confirmation,
      'reminder_template',v_reminder,
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
      v_confirmation,v_reminder,
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
        confirmation_template=v_confirmation,
        reminder_template=v_reminder,
        max_attempts=p_max_attempts,
        base_backoff_seconds=p_base_backoff_seconds,
        max_backoff_seconds=p_max_backoff_seconds
    where venue_id=p_venue and channel=v_channel
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'venue_id',v_row.venue_id,
    'channel',v_row.channel,
    'adapter',v_row.adapter,
    'enabled',v_row.enabled,
    'version',v_row.version,
    'unknown_outcome_policy',v_row.unknown_outcome_policy
  );

  return private.idempotency_finish(
    'message_provider_setting',
    p_key,
    v_result
  );
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
  v_template_key text:=nullif(trim(p_template_key),'');
  v_result jsonb;
  v_row public.reservation_reminder_rules;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_message_channel(p_venue,v_channel);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM','EMAIL')
     or p_offset_minutes not between 15 and 20160
     or p_active is null
     or (v_template_key is not null and length(v_template_key) not between 1 and 160)
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

  if v_template_key is not null
     and not exists(
       select 1
       from public.message_templates t
       where t.venue_id=p_venue
         and t.channel=v_channel
         and t.template_key=v_template_key
         and t.active
     )
  then
    raise exception 'MESSAGE_TEMPLATE_MISSING';
  end if;

  v_result:=private.idempotency_begin(
    'reservation_reminder_rule',
    p_key,
    jsonb_build_object(
      'id',p_id,
      'venue',p_venue,
      'channel',v_channel,
      'offset_minutes',p_offset_minutes,
      'template_key',v_template_key,
      'active',p_active,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.reservation_reminder_rules(
      id,venue_id,channel,offset_minutes,template_key,active
    ) values(
      v_id,p_venue,v_channel,p_offset_minutes,v_template_key,p_active
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
    set channel=v_channel,
        offset_minutes=p_offset_minutes,
        template_key=v_template_key,
        active=p_active
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,
    'venue_id',v_row.venue_id,
    'channel',v_row.channel,
    'offset_minutes',v_row.offset_minutes,
    'active',v_row.active,
    'version',v_row.version
  );

  return private.idempotency_finish(
    'reservation_reminder_rule',
    p_key,
    v_result
  );
end
$$;
