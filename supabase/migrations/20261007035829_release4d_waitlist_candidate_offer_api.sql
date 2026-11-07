create table if not exists private.waitlist_offer_access(
  entry_id uuid primary key references public.waitlist_entries(id) on delete cascade,
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  offered_time time not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

alter table private.waitlist_offer_access enable row level security;
revoke all on table private.waitlist_offer_access from public,anon,authenticated;

create index if not exists waitlist_offer_access_expiry_idx
on private.waitlist_offer_access(expires_at)
where revoked_at is null;

create or replace function private.waitlist_token_hash(p_token text)
returns text
language sql
immutable
set search_path=''
as $$
  select encode(extensions.digest(p_token,'sha256'),'hex')
$$;

revoke all on function private.waitlist_token_hash(text)
from public,anon,authenticated;

create or replace function private.booking_capacity_snapshot(
  p_service uuid,
  p_date date,
  p_time time
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  s public.services;
  r public.service_booking_rules;
  day_rule public.booking_time_slots;
  slot public.booking_time_slots;
  v_total integer;
  v_arrivals integer;
  v_slot_covers integer;
  v_service_remaining integer;
  v_arrival_remaining integer;
  v_slot_remaining integer;
  v_available integer;
  start_minutes integer;
  end_minutes integer;
  selected_minutes integer;
begin
  select * into s from public.services where id=p_service and active;
  if s.id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;

  select * into r from public.service_booking_rules where service_id=s.id;
  if r.service_id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;

  if p_date is null
     or p_time is null
     or not extract(isodow from p_date)::integer=any(s.weekdays) then
    raise exception 'BOOKING_SLOT_UNAVAILABLE';
  end if;

  start_minutes:=extract(epoch from s.starts_at)::integer/60;
  end_minutes:=extract(epoch from s.ends_at)::integer/60;
  selected_minutes:=extract(epoch from p_time)::integer/60;
  if end_minutes<=start_minutes then
    end_minutes:=end_minutes+1440;
    if selected_minutes<start_minutes then selected_minutes:=selected_minutes+1440; end if;
  end if;

  if extract(second from p_time)<>0
     or selected_minutes<start_minutes
     or selected_minutes>=end_minutes
     or (selected_minutes-start_minutes)%r.slot_interval_minutes<>0 then
    raise exception 'BOOKING_SLOT_UNAVAILABLE';
  end if;

  select * into day_rule
  from public.booking_time_slots
  where service_id=s.id and service_date=p_date and slot_time is null;

  select * into slot
  from public.booking_time_slots
  where service_id=s.id and service_date=p_date and slot_time=p_time;

  if coalesce(day_rule.closed,false) or coalesce(slot.closed,false) then
    return jsonb_build_object(
      'available',false,'closed',true,'available_covers',0,'available_arrivals',0
    );
  end if;

  select
    coalesce(sum(party_size),0),
    count(*) filter(where slot_time=p_time),
    coalesce(sum(party_size) filter(where slot_time=p_time),0)
  into v_total,v_arrivals,v_slot_covers
  from public.reservations
  where service_id=s.id
    and service_date=p_date
    and status not in ('CANCELLED','NO_SHOW','EXPIRED');

  v_service_remaining:=greatest(coalesce(day_rule.max_covers_override,r.max_covers_service)-v_total,0);
  v_arrival_remaining:=greatest(coalesce(slot.max_arrivals_override,r.max_arrivals_per_slot)-v_arrivals,0);
  v_slot_remaining:=greatest(coalesce(slot.max_covers_override,r.max_covers_per_slot)-v_slot_covers,0);
  v_available:=least(v_service_remaining,v_slot_remaining);

  return jsonb_build_object(
    'available',v_available>0 and v_arrival_remaining>0,
    'closed',false,
    'available_covers',v_available,
    'available_arrivals',v_arrival_remaining,
    'service_remaining_covers',v_service_remaining,
    'slot_remaining_covers',v_slot_remaining
  );
end
$$;

revoke all on function private.booking_capacity_snapshot(uuid,date,time)
from public,anon,authenticated;

create or replace function public.get_waitlist_candidates(
  p_venue uuid,
  p_service uuid,
  p_date date,
  p_time time,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_capacity jsonb;
  v_available_covers integer;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[]);

  if not private.venue_feature_enabled(p_venue,'WAITLIST') then
    raise exception 'WAITLIST_DISABLED';
  end if;

  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_LIMIT';
  end if;

  if not exists(
    select 1 from public.services
    where id=p_service and venue_id=p_venue and active
  ) then
    raise exception 'SERVICE_UNAVAILABLE';
  end if;

  v_capacity:=private.booking_capacity_snapshot(p_service,p_date,p_time);
  v_available_covers:=coalesce((v_capacity->>'available_covers')::integer,0);

  return jsonb_build_object(
    'venue_id',p_venue,
    'service_id',p_service,
    'service_date',p_date,
    'proposed_time',p_time,
    'capacity',v_capacity,
    'candidates',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',x.id,
          'party_size',x.party_size,
          'customer_name',x.customer_name,
          'preferred_start_time',x.preferred_start_time,
          'preferred_end_time',x.preferred_end_time,
          'compatibility_distance_minutes',x.distance_minutes,
          'created_at',x.created_at
        ) order by x.distance_minutes,x.created_at,x.id
      )
      from (
        select w.*,
               private.waitlist_time_distance_minutes(
                 w.preferred_start_time,w.preferred_end_time,p_time
               ) as distance_minutes
        from public.waitlist_entries w
        where w.venue_id=p_venue
          and w.service_id=p_service
          and w.service_date=p_date
          and w.status='WAITING'
          and w.party_size<=v_available_covers
        order by distance_minutes,w.created_at,w.id
        limit p_limit
      ) x
    ),'[]'::jsonb)
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

  v_result:=jsonb_build_object(
    'entry_id',v_entry.id,
    'status',v_entry.status,
    'offered_time',p_time,
    'expires_at',v_expires,
    'access_token',v_token
  );

  insert into private.public_requests(operation,idempotency_key,payload_hash,response)
  values('waitlist_offer',p_key,v_digest,v_result);

  return v_result;
end
$$;

revoke all on function public.get_waitlist_candidates(uuid,uuid,date,time,integer)
from public,anon;
grant execute on function public.get_waitlist_candidates(uuid,uuid,date,time,integer)
to authenticated,service_role;

revoke all on function public.offer_waitlist_slot(uuid,time,integer,uuid)
from public,anon;
grant execute on function public.offer_waitlist_slot(uuid,time,integer,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_waitlist_candidates(uuid,uuid,date,time without time zone,integer)','authenticated'),
  ('public.offer_waitlist_slot(uuid,time without time zone,integer,uuid)','authenticated')
on conflict do nothing;