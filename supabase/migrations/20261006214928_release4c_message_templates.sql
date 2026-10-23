
create table if not exists public.message_templates(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  channel text not null check(channel in ('WHATSAPP','SMS','TELEGRAM')),
  template_key text not null check(length(trim(template_key)) between 1 and 160),
  locale text not null default 'it-IT' check(length(locale) between 2 and 16),
  body_template text,
  provider_template_ref text,
  active boolean not null default true,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  unique(venue_id,channel,template_key),
  check(body_template is not null or provider_template_ref is not null),
  check(body_template is null or length(body_template) between 1 and 4000),
  check(provider_template_ref is null or length(trim(provider_template_ref)) between 1 and 240),
  check(channel='WHATSAPP' or body_template is not null)
);

alter table public.message_templates enable row level security;
revoke all on table public.message_templates from anon,authenticated;
grant select on table public.message_templates to authenticated;

create policy message_templates_admin_read
on public.message_templates
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists message_templates_venue_idx
on public.message_templates(venue_id,active,channel,template_key);

alter table private.message_job_payloads
  add column if not exists body_template text,
  add column if not exists provider_template_ref text;

alter table private.message_job_payloads
  drop constraint if exists message_job_payloads_template_content_check,
  add constraint message_job_payloads_template_content_check
  check(body_template is not null or provider_template_ref is not null);

create or replace function public.save_message_template(
  p_id uuid,
  p_venue uuid,
  p_channel text,
  p_template_key text,
  p_locale text,
  p_body_template text,
  p_provider_template_ref text,
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
  v_template_key text:=trim(p_template_key);
  v_locale text:=trim(p_locale);
  v_body text:=nullif(p_body_template,'');
  v_provider_ref text:=nullif(trim(p_provider_template_ref),'');
  v_result jsonb;
  v_row public.message_templates;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM')
     or v_template_key is null
     or length(v_template_key) not between 1 and 160
     or v_locale is null
     or length(v_locale) not between 2 and 16
     or (v_body is not null and length(v_body)>4000)
     or (v_provider_ref is not null and length(v_provider_ref)>240)
     or (v_body is null and v_provider_ref is null)
     or (v_channel<>'WHATSAPP' and v_body is null)
     or p_active is null
  then
    raise exception 'INVALID_MESSAGE_TEMPLATE';
  end if;

  v_result:=private.idempotency_begin(
    'message_template',
    p_key,
    jsonb_build_object(
      'id',p_id,
      'venue',p_venue,
      'channel',v_channel,
      'template_key',v_template_key,
      'locale',v_locale,
      'body_template',v_body,
      'provider_template_ref',v_provider_ref,
      'active',p_active,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.message_templates(
      id,venue_id,channel,template_key,locale,
      body_template,provider_template_ref,active
    ) values(
      v_id,p_venue,v_channel,v_template_key,v_locale,
      v_body,v_provider_ref,p_active
    )
    returning * into v_row;
  else
    select * into v_row
    from public.message_templates
    where id=p_id
    for update;

    if v_row.id is null then raise exception 'NOT_FOUND'; end if;
    if v_row.venue_id<>p_venue then
      raise exception 'VENUE_FORBIDDEN' using errcode='42501';
    end if;
    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.message_templates
    set channel=v_channel,
        template_key=v_template_key,
        locale=v_locale,
        body_template=v_body,
        provider_template_ref=v_provider_ref,
        active=p_active
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,
    'venue_id',v_row.venue_id,
    'channel',v_row.channel,
    'template_key',v_row.template_key,
    'version',v_row.version,
    'active',v_row.active
  );

  return private.idempotency_finish('message_template',p_key,v_result);
end
$$;

revoke all on function public.save_message_template(
  uuid,uuid,text,text,text,text,text,boolean,bigint,uuid
) from public,anon;
grant execute on function public.save_message_template(
  uuid,uuid,text,text,text,text,text,boolean,bigint,uuid
) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.save_message_template(uuid,uuid,text,text,text,text,text,boolean,bigint,uuid)',
  'authenticated'
)
on conflict do nothing;

create trigger touch_version
before update on public.message_templates
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update or delete on public.message_templates
for each row execute function private.audit_row();

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
     or (v_confirmation is not null and length(v_confirmation) not between 1 and 160)
     or (v_reminder is not null and length(v_reminder) not between 1 and 160)
     or (v_channel='TELEGRAM' and v_adapter not in ('TELEGRAM','MOCK'))
     or (v_channel in ('WHATSAPP','SMS') and v_adapter not in ('TWILIO','MOCK'))
  then
    raise exception 'INVALID_MESSAGE_PROVIDER_SETTING';
  end if;

  if p_enabled and (
    (v_channel='TELEGRAM' and v_adapter='TELEGRAM' and nullif(trim(p_sender_ref),'') is null)
    or v_confirmation is null
    or v_reminder is null
  ) then
    raise exception 'MESSAGE_PROVIDER_CONFIGURATION_INCOMPLETE';
  end if;

  if p_enabled and (
    not exists(
      select 1 from public.message_templates t
      where t.venue_id=p_venue
        and t.channel=v_channel
        and t.template_key=v_confirmation
        and t.active
    )
    or not exists(
      select 1 from public.message_templates t
      where t.venue_id=p_venue
        and t.channel=v_channel
        and t.template_key=v_reminder
        and t.active
    )
  ) then
    raise exception 'MESSAGE_TEMPLATE_NOT_FOUND';
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
    'version',v_row.version
  );

  return private.idempotency_finish('message_provider_setting',p_key,v_result);
end
$$;

create or replace function private.enqueue_reservation_message(
  p_reservation uuid,
  p_event_type text,
  p_channel text,
  p_scheduled_for timestamptz,
  p_dedupe_key text,
  p_template_override text,
  p_reminder_rule uuid
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare
  v_res public.reservations;
  v_setting public.message_provider_settings;
  v_template public.message_templates;
  v_destination text;
  v_template_key text;
  v_job public.message_jobs;
  v_existing public.message_jobs;
  v_venue_name text;
begin
  if p_reservation is null
     or p_event_type not in ('RESERVATION_CONFIRMATION','RESERVATION_REMINDER')
     or p_channel not in ('WHATSAPP','SMS','TELEGRAM')
     or p_scheduled_for is null
     or p_dedupe_key is null
     or length(p_dedupe_key) not between 16 and 240
     or (p_event_type='RESERVATION_REMINDER')<>(p_reminder_rule is not null)
  then
    raise exception 'INVALID_MESSAGE_REQUEST';
  end if;

  select * into v_res
  from public.reservations
  where id=p_reservation
  for share;

  if v_res.id is null then raise exception 'RESERVATION_NOT_FOUND'; end if;

  if v_res.walk_in
     or v_res.anonymized_at is not null
     or v_res.status<>'RESERVED'
  then
    raise exception 'RESERVATION_NOT_MESSAGEABLE';
  end if;

  if p_reminder_rule is not null and not exists(
    select 1
    from public.reservation_reminder_rules rr
    where rr.id=p_reminder_rule
      and rr.venue_id=v_res.venue_id
      and rr.channel=p_channel
      and rr.active
  ) then
    raise exception 'REMINDER_RULE_NOT_ACTIVE';
  end if;

  select * into v_setting
  from public.message_provider_settings
  where venue_id=v_res.venue_id
    and channel=p_channel
    and enabled;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_CHANNEL_DISABLED';
  end if;

  v_destination:=private.reservation_message_destination(
    p_reservation,p_channel
  );

  if v_destination is null or length(trim(v_destination))<2 then
    raise exception 'MESSAGE_DESTINATION_MISSING';
  end if;

  v_template_key:=coalesce(
    nullif(trim(p_template_override),''),
    case
      when p_event_type='RESERVATION_CONFIRMATION'
        then v_setting.confirmation_template
      else v_setting.reminder_template
    end
  );

  select * into v_template
  from public.message_templates
  where venue_id=v_res.venue_id
    and channel=p_channel
    and template_key=v_template_key
    and active;

  if v_template.id is null then
    raise exception 'MESSAGE_TEMPLATE_MISSING';
  end if;

  insert into public.message_jobs(
    venue_id,reservation_id,reminder_rule_id,event_type,channel,adapter,dedupe_key,
    state,scheduled_for,next_attempt_at,attempts,max_attempts
  ) values(
    v_res.venue_id,v_res.id,p_reminder_rule,p_event_type,p_channel,v_setting.adapter,p_dedupe_key,
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
       or v_existing.channel<>p_channel
       or v_existing.scheduled_for<>p_scheduled_for
       or v_existing.reminder_rule_id is distinct from p_reminder_rule
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
    v_template.locale,
    v_template.template_key,
    jsonb_build_object(
      'reservation_id',v_res.id,
      'first_name',v_res.first_name,
      'last_name',v_res.last_name,
      'service_date',v_res.service_date,
      'slot_time',v_res.slot_time,
      'party_size',v_res.party_size,
      'venue_name',v_venue_name
    ),
    v_template.body_template,
    v_template.provider_template_ref
  );

  return v_job.id;
end
$$;

create or replace function public.claim_message_job(
  p_lease_seconds integer default 60
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
  if p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception 'INVALID_LEASE';
  end if;

  update public.message_jobs j
  set state='FAILED',
      failed_at=clock_timestamp(),
      lease_token=null,
      lease_until=null,
      last_error_code='MESSAGE_OUTCOME_UNKNOWN'
  where j.state='SENDING'
    and j.lease_until<clock_timestamp();

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='RESERVATION_NOT_MESSAGEABLE'
  where j.state='QUEUED'
    and j.reservation_id is not null
    and not exists(
      select 1
      from public.reservations r
      where r.id=j.reservation_id
        and r.status='RESERVED'
        and not r.walk_in
        and r.anonymized_at is null
    );

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='MESSAGE_PROVIDER_CHANGED'
  where j.state='QUEUED'
    and not exists(
      select 1
      from public.message_provider_settings s
      where s.venue_id=j.venue_id
        and s.channel=j.channel
        and s.adapter=j.adapter
        and s.enabled
    );

  select j.*
  into v_job
  from public.message_jobs j
  where j.state='QUEUED'
    and j.next_attempt_at<=clock_timestamp()
    and j.scheduled_for<=clock_timestamp()
    and j.attempts<j.max_attempts
  order by j.next_attempt_at,j.created_at,j.id
  for update skip locked
  limit 1;

  if v_job.id is null then
    return jsonb_build_object('status','IDLE');
  end if;

  update public.message_jobs
  set state='SENDING',
      attempts=attempts+1,
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

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
    and adapter=v_job.adapter
    and enabled;

  if v_setting.venue_id is null then
    raise exception 'MESSAGE_PROVIDER_CHANGED';
  end if;

  return jsonb_build_object(
    'status','CLAIMED',
    'id',v_job.id,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'sender_ref',v_setting.sender_ref,
    'destination',v_payload.destination,
    'locale',v_payload.locale,
    'template_key',v_payload.template_key,
    'body_template',v_payload.body_template,
    'provider_template_ref',v_payload.provider_template_ref,
    'template_data',v_payload.template_data
  );
end
$$;
