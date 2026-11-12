
create table public.waitlist_settings(
  venue_id uuid primary key references public.venues(id) on delete cascade,
  message_offers_enabled boolean not null default false,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.waitlist_settings enable row level security;
revoke all on public.waitlist_settings from public,anon,authenticated;

insert into public.waitlist_settings(venue_id)
select id from public.venues
on conflict(venue_id) do nothing;

create trigger waitlist_settings_touch_version
before update on public.waitlist_settings
for each row execute function private.touch_version();

create or replace function private.bootstrap_waitlist_settings()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  insert into public.waitlist_settings(venue_id)
  values(new.id)
  on conflict(venue_id) do nothing;
  return new;
end
$$;

revoke all on function private.bootstrap_waitlist_settings()
from public,anon,authenticated;

create trigger venue_bootstrap_waitlist_settings
after insert on public.venues
for each row execute function private.bootstrap_waitlist_settings();

alter table public.message_jobs
  add column resource_type text,
  add column resource_id uuid;

alter table public.message_jobs
  add constraint message_jobs_resource_check
  check(
    (event_type='WAITLIST_OFFER'
      and reservation_id is null
      and resource_type='waitlist_entries'
      and resource_id is not null)
    or
    (event_type<>'WAITLIST_OFFER'
      and resource_type is null
      and resource_id is null)
  );

alter table public.message_jobs
  drop constraint message_jobs_event_type_check;

alter table public.message_jobs
  add constraint message_jobs_event_type_check
  check(event_type in (
    'RESERVATION_CONFIRMATION',
    'RESERVATION_REMINDER',
    'WAITLIST_OFFER'
  ));

create index message_jobs_resource_idx
on public.message_jobs(resource_type,resource_id,created_at desc)
where resource_id is not null;

create or replace function private.message_template_variables_valid(p_body text)
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
        'deposit_amount',
        'waitlist_offer_time',
        'waitlist_offer_expires_at',
        'waitlist_accept_url'
      ]::text[])
    )
$$;

create or replace function public.configure_waitlist_messaging(
  p_venue uuid,
  p_enabled boolean,
  p_version bigint,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row public.waitlist_settings;
  v_result jsonb;
begin
  perform private.authorize(
    p_venue,
    array['ADMIN']::public.user_role[]
  );

  if p_venue is null
     or p_enabled is null
     or p_version is null
     or p_key is null
  then
    raise exception 'INVALID_WAITLIST_MESSAGING_CONFIG';
  end if;

  perform private.require_venue_feature(p_venue,'WAITLIST');

  select * into v_row
  from public.waitlist_settings
  where venue_id=p_venue
  for update;

  if v_row.venue_id is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_row.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  if p_enabled and not exists(
    select 1
    from public.message_provider_settings s
    join public.message_templates t
      on t.venue_id=s.venue_id
     and t.channel=s.channel
     and t.template_key='waitlist_offer'
     and t.active
    join public.venues v
      on v.id=s.venue_id
     and t.locale=v.locale
    where s.venue_id=p_venue
      and s.channel in ('WHATSAPP','SMS')
      and s.enabled
      and private.message_channel_enabled(s.venue_id,s.channel)
  ) then
    raise exception 'WAITLIST_MESSAGE_CONFIGURATION_REQUIRED';
  end if;

  v_result:=private.idempotency_begin(
    'waitlist_messaging_config',
    p_key,
    jsonb_build_object(
      'venue',p_venue,
      'enabled',p_enabled,
      'version',p_version
    )
  );
  if v_result is not null then return v_result; end if;

  update public.waitlist_settings
  set message_offers_enabled=p_enabled
  where venue_id=p_venue
  returning * into v_row;

  perform private.audit(
    'WAITLIST_MESSAGING_CONFIGURED',
    'waitlist_settings',
    p_venue,
    p_venue,
    null,
    jsonb_build_object(
      'message_offers_enabled',v_row.message_offers_enabled,
      'version',v_row.version
    )
  );

  v_result:=jsonb_build_object(
    'venue_id',v_row.venue_id,
    'message_offers_enabled',v_row.message_offers_enabled,
    'version',v_row.version
  );

  return private.idempotency_finish(
    'waitlist_messaging_config',
    p_key,
    v_result
  );
end
$$;

revoke all on function public.configure_waitlist_messaging(uuid,boolean,bigint,uuid)
from public,anon;
grant execute on function public.configure_waitlist_messaging(uuid,boolean,bigint,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.configure_waitlist_messaging(uuid,boolean,bigint,uuid)',
  'authenticated'
)
on conflict do nothing;

create or replace function private.enqueue_waitlist_offer_messages(
  p_entry uuid,
  p_access_token text,
  p_offered_time time,
  p_expires_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare
  v_entry public.waitlist_entries;
  v_waitlist_settings public.waitlist_settings;
  v_setting public.message_provider_settings;
  v_template public.message_templates;
  v_job public.message_jobs;
  v_existing public.message_jobs;
  v_venue public.venues;
  v_service public.services;
  v_dedupe text;
  v_count integer:=0;
begin
  if p_entry is null
     or p_access_token is null
     or length(p_access_token) not between 32 and 256
     or p_offered_time is null
     or p_expires_at is null
     or p_expires_at<=clock_timestamp()
  then
    raise exception 'INVALID_WAITLIST_MESSAGE_REQUEST';
  end if;

  select * into v_entry
  from public.waitlist_entries
  where id=p_entry;

  if v_entry.id is null or v_entry.status<>'OFFERED' then
    raise exception 'WAITLIST_NOT_OFFERED';
  end if;

  select * into v_waitlist_settings
  from public.waitlist_settings
  where venue_id=v_entry.venue_id;

  if v_waitlist_settings.venue_id is null
     or not v_waitlist_settings.message_offers_enabled
  then
    return 0;
  end if;

  select * into v_venue
  from public.venues
  where id=v_entry.venue_id;

  select * into v_service
  from public.services
  where id=v_entry.service_id
    and venue_id=v_entry.venue_id;

  for v_setting in
    select *
    from public.message_provider_settings
    where venue_id=v_entry.venue_id
      and channel in ('WHATSAPP','SMS')
      and enabled
      and private.message_channel_enabled(venue_id,channel)
    order by channel
  loop
    select * into v_template
    from public.message_templates
    where venue_id=v_entry.venue_id
      and channel=v_setting.channel
      and template_key='waitlist_offer'
      and locale=v_venue.locale
      and active
    limit 1;

    if v_template.id is null then
      continue;
    end if;

    v_dedupe:=
      'waitlist-offer:'||v_entry.id::text||':'||
      v_entry.version::text||':'||lower(v_setting.channel);

    insert into public.message_jobs(
      venue_id,reservation_id,resource_type,resource_id,
      event_type,channel,adapter,dedupe_key,state,
      scheduled_for,next_attempt_at,attempts,max_attempts
    ) values(
      v_entry.venue_id,null,'waitlist_entries',v_entry.id,
      'WAITLIST_OFFER',v_setting.channel,v_setting.adapter,v_dedupe,'QUEUED',
      clock_timestamp(),clock_timestamp(),0,v_setting.max_attempts
    )
    on conflict(dedupe_key) do nothing
    returning * into v_job;

    if v_job.id is null then
      select * into v_existing
      from public.message_jobs
      where dedupe_key=v_dedupe;

      if v_existing.event_type<>'WAITLIST_OFFER'
         or v_existing.resource_type<>'waitlist_entries'
         or v_existing.resource_id is distinct from v_entry.id
         or v_existing.channel<>v_setting.channel
      then
        raise exception 'MESSAGE_DEDUPE_MISMATCH';
      end if;

      v_count:=v_count+1;
      continue;
    end if;

    insert into private.message_job_payloads(
      job_id,destination,locale,template_key,template_data,
      body_template,provider_template_ref
    ) values(
      v_job.id,
      trim(v_entry.customer_phone),
      v_template.locale,
      v_template.template_key,
      jsonb_build_object(
        'waitlist_entry_id',v_entry.id,
        'waitlist_access_token',p_access_token,
        'customer_name',v_entry.customer_name,
        'venue_name',v_venue.name,
        'reservation_date',v_entry.service_date,
        'reservation_time',p_offered_time,
        'party_size',v_entry.party_size,
        'service_name',v_service.name,
        'deposit_amount',null,
        'waitlist_offer_time',p_offered_time,
        'waitlist_offer_expires_at',p_expires_at
      ),
      v_template.body_template,
      v_template.provider_template_ref
    );

    perform private.audit(
      'WAITLIST_OFFER_MESSAGE_QUEUED',
      'message_jobs',
      v_job.id,
      v_entry.venue_id,
      null,
      jsonb_build_object(
        'waitlist_entry_id',v_entry.id,
        'channel',v_setting.channel,
        'event_type','WAITLIST_OFFER'
      )
    );

    v_count:=v_count+1;
  end loop;

  if v_count=0 then
    raise exception 'WAITLIST_MESSAGE_CONFIGURATION_REQUIRED';
  end if;

  return v_count;
end
$$;

revoke all on function private.enqueue_waitlist_offer_messages(uuid,text,time,timestamptz)
from public,anon,authenticated;

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
  set state='RECONCILIATION_REQUIRED',
      lease_token=null,
      lease_until=null,
      last_error_code='REMOTE_OUTCOME_UNKNOWN'
  where j.state='SENDING'
    and j.lease_until<clock_timestamp();

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='RESERVATION_NOT_MESSAGEABLE'
  where j.state in ('QUEUED','FAILED')
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
      last_error_code='WAITLIST_OFFER_NOT_MESSAGEABLE'
  where j.state in ('QUEUED','FAILED')
    and j.event_type='WAITLIST_OFFER'
    and not exists(
      select 1
      from public.waitlist_entries w
      where w.id=j.resource_id
        and j.resource_type='waitlist_entries'
        and w.status='OFFERED'
        and w.offer_expires_at>clock_timestamp()
    );

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='MESSAGE_FEATURE_DISABLED'
  where j.state in ('QUEUED','FAILED')
    and not private.message_channel_enabled(j.venue_id,j.channel);

  update public.message_jobs j
  set state='CANCELLED',
      cancelled_at=clock_timestamp(),
      last_error_code='MESSAGE_PROVIDER_CHANGED'
  where j.state in ('QUEUED','FAILED')
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
  where j.state in ('QUEUED','FAILED')
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

  update public.message_jobs
  set state='SENDING',
      attempts=attempts+1,
      lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=null
  where id=v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'status','CLAIMED',
    'id',v_job.id,
    'provider_idempotency_key',v_job.id,
    'lease_token',v_job.lease_token,
    'lease_until',v_job.lease_until,
    'attempt',v_job.attempts,
    'max_attempts',v_job.max_attempts,
    'venue_id',v_job.venue_id,
    'reservation_id',v_job.reservation_id,
    'resource_type',v_job.resource_type,
    'resource_id',v_job.resource_id,
    'event_type',v_job.event_type,
    'channel',v_job.channel,
    'adapter',v_job.adapter,
    'unknown_outcome_policy',v_setting.unknown_outcome_policy,
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

create or replace function public.offer_waitlist_slot(
  p_entry uuid,
  p_time time,
  p_offer_minutes integer,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_entry public.waitlist_entries;
  v_candidates jsonb;
  v_first uuid;
  v_token text;
  v_expires timestamptz;
  v_result jsonb;
  v_existing private.public_requests;
  v_digest text;
  v_message_jobs integer:=0;
begin
  if p_entry is null or p_time is null or p_offer_minutes not between 1 and 1440 or p_key is null then
    raise exception 'INVALID_WAITLIST_OFFER';
  end if;

  select * into v_entry
  from public.waitlist_entries
  where id=p_entry
  for update;

  if v_entry.id is null then raise exception 'NOT_FOUND'; end if;

  perform private.authorize(v_entry.venue_id,array['ADMIN','HOST']::public.user_role[]);

  if not private.venue_feature_enabled(v_entry.venue_id,'WAITLIST') then
    raise exception 'WAITLIST_DISABLED';
  end if;

  v_digest:=encode(extensions.digest(
    jsonb_build_object('entry',p_entry,'time',p_time,'offer_minutes',p_offer_minutes)::text,
    'sha256'
  ),'hex');

  perform pg_advisory_xact_lock(hashtextextended('waitlist_offer:'||p_key::text,0));

  select * into v_existing
  from private.public_requests
  where operation='waitlist_offer' and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return v_existing.response;
  end if;

  if v_entry.status<>'WAITING' then raise exception 'WAITLIST_NOT_WAITING'; end if;

  v_candidates:=public.get_waitlist_candidates(
    v_entry.venue_id,v_entry.service_id,v_entry.service_date,p_time,200
  );

  v_first:=nullif(v_candidates->'candidates'->0->>'id','')::uuid;
  if v_first is null then raise exception 'WAITLIST_NO_COMPATIBLE_CAPACITY'; end if;
  if v_first<>v_entry.id then raise exception 'WAITLIST_PRIORITY_CONFLICT'; end if;

  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  v_expires:=clock_timestamp()+make_interval(mins=>p_offer_minutes);

  update public.waitlist_entries
  set status='OFFERED',
      offered_at=clock_timestamp(),
      offer_expires_at=v_expires
  where id=v_entry.id
  returning * into v_entry;

  insert into private.waitlist_offer_access(
    entry_id,token_hash,offered_time,expires_at
  ) values(
    v_entry.id,private.waitlist_token_hash(v_token),p_time,v_expires
  )
  on conflict(entry_id) do update
  set token_hash=excluded.token_hash,
      offered_time=excluded.offered_time,
      expires_at=excluded.expires_at,
      revoked_at=null,
      created_at=clock_timestamp();

  v_message_jobs:=private.enqueue_waitlist_offer_messages(
    v_entry.id,v_token,p_time,v_expires
  );

  v_result:=jsonb_build_object(
    'entry_id',v_entry.id,
    'status',v_entry.status,
    'offered_time',p_time,
    'expires_at',v_expires,
    'access_token',v_token,
    'message_jobs_queued',v_message_jobs
  );

  insert into private.public_requests(operation,idempotency_key,payload_hash,response)
  values('waitlist_offer',p_key,v_digest,v_result);

  return v_result;
end
$$;

insert into private.release_test_catalog(key,category,required,description)
values(
  'WAITLIST_OFFER_MESSAGE_BRIDGE',
  'INTEGRATION',
  true,
  'When Admin enables waitlist offer messaging, offering a compatible waitlist entry atomically queues phone-based WAITLIST_OFFER message jobs using private token payloads; no reservation row is fabricated and expired offers are cancelled before provider delivery.'
)
on conflict(key) do nothing;
