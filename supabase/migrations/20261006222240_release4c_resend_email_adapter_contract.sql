
alter table public.message_provider_settings
  drop constraint if exists message_provider_settings_adapter_check,
  drop constraint if exists message_provider_settings_channel_adapter_check;

alter table public.message_provider_settings
  add constraint message_provider_settings_adapter_check
    check(adapter=any(array['TWILIO','TELEGRAM','RESEND','MOCK']::text[])),
  add constraint message_provider_settings_channel_adapter_check
    check(
      (channel='TELEGRAM' and adapter=any(array['TELEGRAM','MOCK']::text[]))
      or (channel=any(array['WHATSAPP','SMS']::text[]) and adapter=any(array['TWILIO','MOCK']::text[]))
      or (channel='EMAIL' and adapter=any(array['RESEND','MOCK']::text[]))
    );

alter table public.message_jobs
  drop constraint if exists message_jobs_adapter_check;

alter table public.message_jobs
  add constraint message_jobs_adapter_check
    check(adapter=any(array['TWILIO','TELEGRAM','RESEND','MOCK']::text[]));

create unique index if not exists message_jobs_provider_message_unique_idx
on public.message_jobs(adapter,provider_message_id)
where provider_message_id is not null;

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
     or (p_confirmation_template is not null and length(trim(p_confirmation_template)) not between 1 and 160)
     or (p_reminder_template is not null and length(trim(p_reminder_template)) not between 1 and 160)
     or (v_channel='TELEGRAM' and v_adapter not in ('TELEGRAM','MOCK'))
     or (v_channel in ('WHATSAPP','SMS') and v_adapter not in ('TWILIO','MOCK'))
     or (v_channel='EMAIL' and v_adapter not in ('RESEND','MOCK'))
  then
    raise exception 'INVALID_MESSAGE_PROVIDER_SETTING';
  end if;

  if p_enabled and (
    (v_channel in ('TELEGRAM','EMAIL') and nullif(trim(p_sender_ref),'') is null)
    or p_confirmation_template is null
    or p_reminder_template is null
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
    'venue_id',v_row.venue_id,
    'channel',v_row.channel,
    'adapter',v_row.adapter,
    'enabled',v_row.enabled,
    'version',v_row.version
  );

  return private.idempotency_finish('message_provider_setting',p_key,v_result);
end
$$;

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
     or p_adapter not in ('TWILIO','TELEGRAM','RESEND','MOCK')
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
