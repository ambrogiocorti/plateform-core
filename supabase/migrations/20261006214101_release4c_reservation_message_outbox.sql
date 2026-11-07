
create table if not exists private.reservation_message_contacts(
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  channel text not null check(channel in ('WHATSAPP','SMS','TELEGRAM')),
  destination text not null check(length(destination) between 2 and 240),
  verified_at timestamptz,
  source text,
  created_at timestamptz not null default clock_timestamp(),
  primary key(reservation_id,channel),
  check(source is null or length(trim(source)) between 1 and 120)
);

create table if not exists private.reservation_message_outbox(
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id),
  venue_id uuid not null references public.venues(id),
  event_type text not null check(event_type='RESERVATION_CONFIRMED'),
  event_key text not null unique check(length(event_key) between 16 and 240),
  attempts integer not null default 0 check(attempts>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text,
  processed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check(last_error_code is null or length(last_error_code) between 1 and 120)
);

alter table private.reservation_message_contacts enable row level security;
alter table private.reservation_message_outbox enable row level security;

revoke all on table private.reservation_message_contacts from public,anon,authenticated;
revoke all on table private.reservation_message_outbox from public,anon,authenticated;

create index if not exists reservation_message_contacts_channel_idx
on private.reservation_message_contacts(channel,reservation_id);

create index if not exists reservation_message_outbox_due_idx
on private.reservation_message_outbox(next_attempt_at,created_at)
where processed_at is null;

create index if not exists reservation_message_outbox_reservation_idx
on private.reservation_message_outbox(reservation_id,created_at desc);

create index if not exists reservation_message_outbox_venue_idx
on private.reservation_message_outbox(venue_id,created_at desc);

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

revoke all on function private.reservation_message_event()
from public,anon,authenticated;

drop trigger if exists reservation_message_event on public.reservations;
create trigger reservation_message_event
after insert or update of status on public.reservations
for each row execute function private.reservation_message_event();

create or replace function private.reservation_message_destination(
  p_reservation uuid,
  p_channel text
)
returns text
language sql
stable
security definer
set search_path=''
as $$
  select coalesce(
    (
      select c.destination
      from private.reservation_message_contacts c
      where c.reservation_id=p_reservation
        and c.channel=p_channel
        and c.verified_at is not null
    ),
    case
      when p_channel in ('WHATSAPP','SMS')
      then (
        select r.phone
        from public.reservations r
        where r.id=p_reservation
          and r.anonymized_at is null
      )
    end
  )
$$;

revoke all on function private.reservation_message_destination(uuid,text)
from public,anon,authenticated;

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
begin
  if p_reservation is null
     or p_event_type not in ('RESERVATION_CONFIRMATION','RESERVATION_REMINDER')
     or p_channel not in ('WHATSAPP','SMS','TELEGRAM')
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

  if v_res.walk_in
     or v_res.anonymized_at is not null
     or v_res.status<>'RESERVED'
  then
    raise exception 'RESERVATION_NOT_MESSAGEABLE';
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
    venue_id,reservation_id,event_type,channel,adapter,dedupe_key,
    state,scheduled_for,next_attempt_at,attempts,max_attempts
  ) values(
    v_res.venue_id,v_res.id,p_event_type,p_channel,v_setting.adapter,p_dedupe_key,
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
  uuid,text,text,timestamptz,text,text
) from public,anon,authenticated;

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

revoke all on function public.run_reservation_message_outbox(integer)
from public,anon,authenticated;
grant execute on function public.run_reservation_message_outbox(integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.run_reservation_message_outbox(integer)','service_role')
on conflict do nothing;
