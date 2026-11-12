
alter table public.message_jobs
  add column if not exists reminder_rule_id uuid references public.reservation_reminder_rules(id);

alter table public.message_jobs
  drop constraint if exists message_jobs_reminder_rule_check,
  add constraint message_jobs_reminder_rule_check
  check (
    (event_type='RESERVATION_REMINDER' and reminder_rule_id is not null)
    or (event_type<>'RESERVATION_REMINDER' and reminder_rule_id is null)
  );

create index if not exists message_jobs_reminder_rule_idx
on public.message_jobs(reminder_rule_id,reservation_id,created_at desc)
where reminder_rule_id is not null;

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
  v_destination text;
  v_template text;
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
    p_reservation,p_event_type,p_channel,p_scheduled_for,
    p_dedupe_key,p_template_override,null::uuid
  )
$$;

revoke all on function private.enqueue_reservation_message(
  uuid,text,text,timestamptz,text,text
) from public,anon,authenticated;

create or replace function private.reservation_message_event()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_op='UPDATE'
     and old.status='RESERVED'
     and new.status<>'RESERVED'
  then
    update public.message_jobs
    set state='CANCELLED',
        cancelled_at=clock_timestamp(),
        lease_token=null,
        lease_until=null,
        last_error_code='RESERVATION_STATE_CHANGED'
    where reservation_id=new.id
      and state in ('QUEUED','SENDING','FAILED');

    return new;
  end if;

  if new.walk_in
     or new.anonymized_at is not null
     or new.status<>'RESERVED'
     or (
       tg_op='UPDATE'
       and old.status is not distinct from new.status
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

create or replace function public.run_reservation_message_outbox(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event private.reservation_message_outbox;
  v_setting public.message_provider_settings;
  v_created integer:=0;
  v_processed integer:=0;
  v_failed integer:=0;
  v_error text;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'INVALID_LIMIT';
  end if;

  for v_event in
    select *
    from private.reservation_message_outbox
    where processed_at is null
      and next_attempt_at<=clock_timestamp()
    order by created_at,id
    for update skip locked
    limit p_limit
  loop
    begin
      if not exists(
        select 1
        from public.reservations r
        where r.id=v_event.reservation_id
          and r.status='RESERVED'
          and not r.walk_in
          and r.anonymized_at is null
      ) then
        update private.reservation_message_outbox
        set processed_at=clock_timestamp(),
            attempts=attempts+1,
            last_error_code='RESERVATION_NOT_MESSAGEABLE'
        where id=v_event.id;

        v_processed:=v_processed+1;
        continue;
      end if;

      for v_setting in
        select *
        from public.message_provider_settings
        where venue_id=v_event.venue_id
          and enabled
        order by channel
      loop
        perform private.enqueue_reservation_message(
          v_event.reservation_id,
          'RESERVATION_CONFIRMATION',
          v_setting.channel,
          v_event.created_at,
          v_event.event_key||':'||lower(v_setting.channel),
          null
        );

        v_created:=v_created+1;
      end loop;

      update private.reservation_message_outbox
      set processed_at=clock_timestamp(),
          attempts=attempts+1,
          last_error_code=null
      where id=v_event.id;

      v_processed:=v_processed+1;
    exception when others then
      get stacked diagnostics v_error=message_text;

      update private.reservation_message_outbox
      set attempts=attempts+1,
          last_error_code=left(v_error,120),
          next_attempt_at=clock_timestamp()
            + make_interval(
                secs=>least(
                  3600,
                  greatest(30,30*(2^least(attempts,6))::integer)
                )
              )
      where id=v_event.id;

      v_failed:=v_failed+1;
    end;
  end loop;

  return jsonb_build_object(
    'processed_events',v_processed,
    'jobs_created_or_reused',v_created,
    'failed_events',v_failed
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

revoke all on function public.run_reservation_reminder_scheduler(
  timestamptz,integer,integer
) from public,anon,authenticated;
grant execute on function public.run_reservation_reminder_scheduler(
  timestamptz,integer,integer
) to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.run_reservation_reminder_scheduler(timestamp with time zone,integer,integer)',
  'service_role'
)
on conflict do nothing;

create or replace function private.audit_values(p_value jsonb)
returns jsonb
language sql
immutable
set search_path=''
as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  from jsonb_each(coalesce(p_value,'{}'::jsonb))
  where key=any(array[
    'id','venue_id','menu_id','public_menu_id','slug','published','weekdays','starts_at','ends_at',
    'available_from','available_until','sort_order','priority','display_mode','max_impressions_per_session',
    'reservation_id','reminder_rule_id','event_type','channel','adapter','dedupe_key','state','scheduled_for','next_attempt_at',
    'attempts','max_attempts','provider_message_id','last_error_code','sent_at','delivered_at','failed_at','cancelled_at',
    'offset_minutes',
    'role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit','yield_factor','waste_percentage','removable',
    'ingredient_id','cost_micros','purchase_unit','effective_from','effective_to',
    'food_cost_micros','food_cost_cents','food_cost_percentage',
    'gross_margin_micros','gross_margin_cents','gross_margin_percentage','selling_price_cents','as_of',
    'unit_price_cents','amount_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by',
    'error_code','purpose'
  ])
$$;
