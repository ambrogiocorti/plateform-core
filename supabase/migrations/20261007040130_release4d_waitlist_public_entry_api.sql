create or replace function public.create_waitlist_entry(
  p_venue uuid,
  p_service uuid,
  p_date date,
  p_preferred_start time,
  p_preferred_end time,
  p_party integer,
  p_customer_name text,
  p_customer_phone text,
  p_notes text,
  p_key uuid,
  p_rate_key text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v public.venues;
  s public.services;
  v_existing private.public_requests;
  v_digest text;
  v_id uuid;
  v_result jsonb;
  start_minutes integer;
  end_minutes integer;
  preferred_start_minutes integer;
  preferred_end_minutes integer;
begin
  if p_rate_key is null
     or length(p_rate_key) not between 32 and 128
     or not private.check_rate_limit('waitlist:'||p_rate_key,10,600) then
    return jsonb_build_object('error','RATE_LIMITED');
  end if;

  if p_key is null
     or p_venue is null
     or p_service is null
     or p_date is null
     or p_preferred_start is null
     or p_party not between 1 and 1000
     or length(trim(p_customer_name)) not between 1 and 160
     or p_customer_phone !~ E'^\\+[0-9]{7,15}$'
     or (p_notes is not null and length(p_notes)>2000)
  then
    raise exception 'INVALID_WAITLIST_REQUEST';
  end if;

  v_digest:=encode(extensions.digest(
    jsonb_build_object(
      'venue',p_venue,'service',p_service,'date',p_date,
      'preferred_start',p_preferred_start,'preferred_end',p_preferred_end,
      'party',p_party,'name',trim(p_customer_name),'phone',p_customer_phone,
      'notes',nullif(trim(p_notes),'')
    )::text,'sha256'
  ),'hex');

  perform pg_advisory_xact_lock(hashtextextended('waitlist:'||p_key::text,0));

  select * into v_existing
  from private.public_requests
  where operation='waitlist_create' and idempotency_key=p_key;

  if found then
    if v_existing.payload_hash<>v_digest then
      raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023';
    end if;
    return v_existing.response;
  end if;

  select * into v
  from public.venues
  where id=p_venue and active and operational_status='OPEN';

  if v.id is null or not private.installation_active() then
    raise exception 'VENUE_UNAVAILABLE';
  end if;

  if not private.venue_feature_enabled(v.id,'WAITLIST') then
    raise exception 'WAITLIST_DISABLED';
  end if;

  select * into s
  from public.services
  where id=p_service and venue_id=v.id and active;

  if s.id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;

  if p_date<(now() at time zone v.timezone)::date
     or p_date>(now() at time zone v.timezone)::date+180
     or not extract(isodow from p_date)::integer=any(s.weekdays)
  then
    raise exception 'WAITLIST_DATE_UNAVAILABLE';
  end if;

  start_minutes:=extract(epoch from s.starts_at)::integer/60;
  end_minutes:=extract(epoch from s.ends_at)::integer/60;
  preferred_start_minutes:=extract(epoch from p_preferred_start)::integer/60;

  if end_minutes<=start_minutes then
    end_minutes:=end_minutes+1440;
    if preferred_start_minutes<start_minutes then preferred_start_minutes:=preferred_start_minutes+1440; end if;
  end if;

  if preferred_start_minutes<start_minutes or preferred_start_minutes>=end_minutes then
    raise exception 'WAITLIST_TIME_UNAVAILABLE';
  end if;

  if p_preferred_end is not null then
    preferred_end_minutes:=extract(epoch from p_preferred_end)::integer/60;
    if end_minutes>1440 and preferred_end_minutes<start_minutes then preferred_end_minutes:=preferred_end_minutes+1440; end if;
    if preferred_end_minutes<preferred_start_minutes or preferred_end_minutes>end_minutes then
      raise exception 'WAITLIST_TIME_UNAVAILABLE';
    end if;
  end if;

  if ((p_date+make_interval(mins=>preferred_start_minutes)) at time zone v.timezone)<=clock_timestamp() then
    raise exception 'WAITLIST_IN_PAST';
  end if;

  insert into public.waitlist_entries(
    venue_id,service_id,service_date,preferred_start_time,preferred_end_time,
    party_size,customer_name,customer_phone,notes,status
  ) values(
    v.id,s.id,p_date,p_preferred_start,p_preferred_end,
    p_party,trim(p_customer_name),p_customer_phone,nullif(trim(p_notes),''),'WAITING'
  ) returning id into v_id;

  insert into public.notifications(
    venue_id,recipient_role,category,title,resource_type,resource_id
  ) values(
    v.id,'HOST','RESERVATION','Nuovo ingresso in lista d''attesa','waitlist_entries',v_id
  );

  v_result:=jsonb_build_object(
    'id',v_id,
    'status','WAITING',
    'service_date',p_date,
    'preferred_start_time',p_preferred_start,
    'preferred_end_time',p_preferred_end
  );

  insert into private.public_requests(operation,idempotency_key,payload_hash,response)
  values('waitlist_create',p_key,v_digest,v_result);

  return v_result;
end
$$;

revoke all on function public.create_waitlist_entry(uuid,uuid,date,time,time,integer,text,text,text,uuid,text)
from public,anon,authenticated;
grant execute on function public.create_waitlist_entry(uuid,uuid,date,time,time,integer,text,text,text,uuid,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.create_waitlist_entry(uuid,uuid,date,time without time zone,time without time zone,integer,text,text,text,uuid,text)','service_role')
on conflict do nothing;