
alter table public.message_templates
  drop constraint if exists message_templates_channel_check;
alter table public.message_templates
  add constraint message_templates_channel_check
    check(channel=any(array['WHATSAPP','SMS','TELEGRAM','EMAIL']::text[]));

create or replace function private.message_template_variables_valid(
  p_body text
)
returns boolean
language sql
immutable
set search_path=''
as $$
  select
    p_body is null
    or not exists(
      select 1
      from regexp_matches(
        p_body,
        '\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}',
        'g'
      ) m
      where m[1]<>all(array[
        'customer_name',
        'venue_name',
        'reservation_date',
        'reservation_time',
        'party_size',
        'service_name',
        'deposit_amount'
      ]::text[])
    )
$$;

revoke all on function private.message_template_variables_valid(text)
from public,anon,authenticated;

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
  perform private.require_message_channel(p_venue,v_channel);

  if p_key is null
     or p_venue is null
     or v_channel not in ('WHATSAPP','SMS','TELEGRAM','EMAIL')
     or v_template_key is null
     or length(v_template_key) not between 1 and 160
     or v_locale is null
     or length(v_locale) not between 2 and 16
     or (v_body is not null and length(v_body)>4000)
     or (v_provider_ref is not null and length(v_provider_ref)>240)
     or (v_body is null and v_provider_ref is null)
     or (v_channel<>'WHATSAPP' and v_body is null)
     or not private.message_template_variables_valid(v_body)
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
  v_service_name text;
begin
  if p_reservation is null
     or p_event_type not in ('RESERVATION_CONFIRMATION','RESERVATION_REMINDER')
     or p_channel not in ('WHATSAPP','SMS','TELEGRAM','EMAIL')
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

  perform private.require_message_channel(v_res.venue_id,p_channel);

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

  select name into v_service_name
  from public.services
  where id=v_res.service_id;

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
      'customer_name',trim(v_res.first_name||' '||coalesce(v_res.last_name,'')),
      'venue_name',v_venue_name,
      'reservation_date',v_res.service_date,
      'reservation_time',v_res.slot_time,
      'party_size',v_res.party_size,
      'service_name',v_service_name,
      'deposit_amount',null
    ),
    v_template.body_template,
    v_template.provider_template_ref
  );

  return v_job.id;
end
$$;

revoke all on function private.enqueue_reservation_message(
  uuid,text,text,timestamptz,text,text,uuid
) from public,anon,authenticated;

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
    p_channel,
    p_scheduled_for,
    p_dedupe_key,
    p_template_override,
    null::uuid
  )
$$;

revoke all on function private.enqueue_reservation_message(
  uuid,text,text,timestamptz,text,text
) from public,anon,authenticated;

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
      last_error_code='MESSAGE_FEATURE_DISABLED'
  where j.state='QUEUED'
    and not private.message_channel_enabled(j.venue_id,j.channel);

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
    and private.message_channel_enabled(j.venue_id,j.channel)
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
     or p_adapter not in ('TWILIO','TELEGRAM','SMTP','MOCK')
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

create or replace function public.run_reservation_reminder_scheduler(
  p_now timestamptz default clock_timestamp(),
  p_horizon_minutes integer default 15,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row record;
  v_job uuid;
  v_enqueued integer:=0;
  v_reused integer:=0;
  v_cancelled integer:=0;
  v_row_count integer:=0;
  v_key text;
begin
  if p_now is null
     or p_horizon_minutes not between 0 and 1440
     or p_limit not between 1 and 2000
  then
    raise exception 'INVALID_REMINDER_SCHEDULER_INPUT';
  end if;

  for v_row in
    select
      r.id as reservation_id,
      r.venue_id,
      rr.id as rule_id,
      rr.channel,
      rr.offset_minutes,
      rr.template_key,
      ((r.service_date+r.slot_time) at time zone v.timezone) as service_at,
      (((r.service_date+r.slot_time) at time zone v.timezone)
        - make_interval(mins=>rr.offset_minutes)) as scheduled_for
    from public.reservations r
    join public.venues v on v.id=r.venue_id and v.active
    join public.reservation_reminder_rules rr
      on rr.venue_id=r.venue_id and rr.active
    join public.message_provider_settings s
      on s.venue_id=r.venue_id
     and s.channel=rr.channel
     and s.enabled
    where r.status='RESERVED'
      and not r.walk_in
      and r.anonymized_at is null
      and private.message_channel_enabled(r.venue_id,rr.channel)
      and ((r.service_date+r.slot_time) at time zone v.timezone)>p_now
      and (
        ((r.service_date+r.slot_time) at time zone v.timezone)
          - make_interval(mins=>rr.offset_minutes)
      ) <= p_now+make_interval(mins=>p_horizon_minutes)
      and (
        ((r.service_date+r.slot_time) at time zone v.timezone)
          - make_interval(mins=>rr.offset_minutes)
      ) >= p_now-interval '24 hours'
    order by scheduled_for,r.id,rr.id
    limit p_limit
  loop
    v_key:=
      'reservation-reminder:'
      ||v_row.reservation_id::text
      ||':'
      ||v_row.rule_id::text
      ||':'
      ||to_char(v_row.service_at at time zone 'UTC','YYYYMMDDHH24MISS');

    update public.message_jobs
    set state='CANCELLED',
        cancelled_at=clock_timestamp(),
        lease_token=null,
        lease_until=null,
        last_error_code='REMINDER_SCHEDULE_CHANGED'
    where reservation_id=v_row.reservation_id
      and reminder_rule_id=v_row.rule_id
      and event_type='RESERVATION_REMINDER'
      and dedupe_key<>v_key
      and state in ('QUEUED','SENDING','FAILED');

    get diagnostics v_row_count = row_count;
    v_cancelled:=v_cancelled+v_row_count;

    if exists(select 1 from public.message_jobs where dedupe_key=v_key) then
      v_reused:=v_reused+1;
    else
      v_job:=private.enqueue_reservation_message(
        v_row.reservation_id,
        'RESERVATION_REMINDER',
        v_row.channel,
        v_row.scheduled_for,
        v_key,
        v_row.template_key,
        v_row.rule_id
      );
      v_enqueued:=v_enqueued+1;
    end if;
  end loop;

  return jsonb_build_object(
    'enqueued',v_enqueued,
    'reused',v_reused,
    'cancelled_stale',v_cancelled
  );
end
$$;
