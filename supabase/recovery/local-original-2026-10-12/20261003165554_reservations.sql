begin;
create table private.public_requests (
  operation text not null, idempotency_key uuid not null, payload_hash text not null, response jsonb not null,
  created_at timestamptz not null default now(), primary key(operation,idempotency_key)
);
create function private.check_rate_limit(p_bucket text,p_limit integer,p_seconds integer) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.rate_limits;
begin
  insert into private.rate_limits(bucket) values(p_bucket) on conflict do nothing;
  select * into r from private.rate_limits where bucket=p_bucket for update;
  if r.blocked_until>now() then return false; end if;
  if r.window_started_at<now()-make_interval(secs=>p_seconds) then
    update private.rate_limits set attempts=1,window_started_at=now(),blocked_until=null where bucket=p_bucket; return true;
  end if;
  update private.rate_limits set attempts=attempts+1,
    blocked_until=case when attempts+1>p_limit then now()+make_interval(secs=>p_seconds) else null end where bucket=p_bucket;
  return r.attempts+1<=p_limit;
end $$;

create function public.get_booking_configuration(p_venue uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('services',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'starts_at',s.starts_at,'ends_at',s.ends_at,'weekdays',s.weekdays,'slot_interval_minutes',r.slot_interval_minutes))
    from public.services s join public.service_booking_rules r on r.service_id=s.id where s.venue_id=v.id and s.active),'[]'),
    'fields',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'key',f.key,'type',f.type,'label',f.label,'placeholder',f.placeholder,'required',f.required,'options',f.options) order by f.sort_order)
      from public.reservation_form_fields f join public.reservation_form_definitions d on d.id=f.form_id where d.venue_id=v.id and d.active and f.visible),'[]'))
  from public.venues v join public.venue_settings s on s.venue_id=v.id where v.id=p_venue and v.active and v.operational_status='OPEN' and s.reservations_enabled and private.installation_active()
$$;

create function public.create_public_reservation(p_venue uuid,p_service uuid,p_date date,p_time time,p_first_name text,p_last_name text,p_phone text,p_party integer,p_answers jsonb,p_key uuid,p_rate_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.venues; s public.services; rules public.service_booking_rules; slot public.booking_time_slots; day_rule public.booking_time_slots;
  total integer; arrivals integer; covers integer; start_minutes integer; selected_minutes integer; end_minutes integer;
  booking_status public.reservation_status; ref uuid; duplicate private.public_requests; digest text; answer record; form_field public.reservation_form_fields; result jsonb;
begin
  if not private.check_rate_limit('booking:'||p_rate_key,10,600) then return jsonb_build_object('error','RATE_LIMITED'); end if;
  if length(p_rate_key) not between 32 and 128 or p_key is null then raise exception 'INVALID_REQUEST'; end if;
  select * into v from public.venues where id=p_venue and active and operational_status='OPEN';
  if v.id is null or not private.installation_active() or not exists(select 1 from public.venue_settings where venue_id=v.id and reservations_enabled) then raise exception 'RESERVATIONS_DISABLED'; end if;
  select * into s from public.services where id=p_service and venue_id=v.id and active for update;
  select * into rules from public.service_booking_rules where service_id=s.id;
  if s.id is null or rules.service_id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;
  digest:=encode(extensions.digest(jsonb_build_object('venue',p_venue,'service',p_service,'date',p_date,'time',p_time,'first',p_first_name,'last',p_last_name,'phone',p_phone,'party',p_party,'answers',p_answers)::text,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('booking:'||p_key::text,0));
  select * into duplicate from private.public_requests where operation='booking' and idempotency_key=p_key;
  if found then
    if duplicate.payload_hash<>digest then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return duplicate.response;
  end if;
  if length(trim(p_first_name)) not between 1 and 100 or length(p_last_name)>100 or p_phone !~ '^\+[0-9]{7,15}$' or p_party not between 1 and 1000 then raise exception 'INVALID_BOOKING_DETAILS'; end if;
  if p_date is null or p_date<(now() at time zone v.timezone)::date or p_date>(now() at time zone v.timezone)::date+180
    or not extract(isodow from p_date)::integer=any(s.weekdays) then raise exception 'BOOKING_DATE_UNAVAILABLE'; end if;
  start_minutes:=extract(epoch from s.starts_at)::integer/60; end_minutes:=extract(epoch from s.ends_at)::integer/60;
  selected_minutes:=extract(epoch from p_time)::integer/60;
  if end_minutes<=start_minutes then
    end_minutes:=end_minutes+1440; if selected_minutes<start_minutes then selected_minutes:=selected_minutes+1440; end if;
  end if;
  if p_time is null or extract(second from p_time)<>0 or selected_minutes<start_minutes or selected_minutes>=end_minutes or (selected_minutes-start_minutes)%rules.slot_interval_minutes<>0 then raise exception 'BOOKING_SLOT_UNAVAILABLE'; end if;
  if (p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone<=now() then raise exception 'BOOKING_IN_PAST'; end if;
  select * into day_rule from public.booking_time_slots where service_id=s.id and service_date=p_date and slot_time is null;
  select * into slot from public.booking_time_slots where service_id=s.id and service_date=p_date and slot_time=p_time;
  if coalesce(day_rule.closed,false) or coalesce(slot.closed,false) then raise exception 'BOOKING_CLOSED'; end if;
  select coalesce(sum(party_size),0),count(*) filter(where slot_time=p_time),coalesce(sum(party_size) filter(where slot_time=p_time),0)
    into total,arrivals,covers from public.reservations where service_id=s.id and service_date=p_date and status not in ('CANCELLED','NO_SHOW');
  if total+p_party>coalesce(day_rule.max_covers_override,rules.max_covers_service) or arrivals+1>coalesce(slot.max_arrivals_override,rules.max_arrivals_per_slot)
    or covers+p_party>coalesce(slot.max_covers_override,rules.max_covers_per_slot) then raise exception 'BOOKING_CAPACITY_REACHED'; end if;
  booking_status:='RESERVED';
  if p_party>rules.max_party_size_auto_confirm then
    if rules.large_party_mode='REJECT' then raise exception 'CONTACT_RESTAURANT_FOR_LARGE_PARTY'; end if;
    booking_status:='REQUESTED';
  end if;
  if jsonb_typeof(p_answers)<>'object' or pg_column_size(p_answers)>16384 then raise exception 'INVALID_FORM_ANSWERS'; end if;
  if exists(select 1 from public.reservation_form_fields f join public.reservation_form_definitions d on d.id=f.form_id
    where d.venue_id=v.id and d.active and f.visible and f.required and (not p_answers ? f.id::text or p_answers->f.id::text in ('null'::jsonb,'""'::jsonb,'[]'::jsonb))) then raise exception 'FORM_REQUIRED_FIELDS'; end if;
  insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status)
    values(v.id,s.id,p_date,p_time,trim(p_first_name),trim(p_last_name),p_phone,p_party,booking_status) returning id into ref;
  for answer in select key,value from jsonb_each(p_answers) loop
    select f.* into form_field from public.reservation_form_fields f join public.reservation_form_definitions d on d.id=f.form_id
      where f.id::text=answer.key and d.venue_id=v.id and d.active and f.visible;
    if form_field.id is null then raise exception 'UNKNOWN_FORM_FIELD'; end if;
    if form_field.type in ('select','radio') and not form_field.options @> jsonb_build_array(answer.value) then raise exception 'INVALID_FORM_OPTION'; end if;
    if form_field.type='number' and jsonb_typeof(answer.value)<>'number' then raise exception 'INVALID_FORM_NUMBER'; end if;
    if form_field.type='checkbox' and jsonb_typeof(answer.value) not in ('boolean','array') then raise exception 'INVALID_FORM_CHECKBOX'; end if;
    if form_field.type in ('text','textarea','tel','date','time') and (jsonb_typeof(answer.value)<>'string' or length(answer.value#>>'{}')>2000) then raise exception 'INVALID_FORM_TEXT'; end if;
    insert into public.reservation_answers(venue_id,reservation_id,field_id,answer) values(v.id,ref,form_field.id,answer.value);
  end loop;
  insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id) values(v.id,'HOST','RESERVATION','Nuova prenotazione','reservations',ref);
  result:=jsonb_build_object('id',ref,'status',booking_status);
  insert into private.public_requests(operation,idempotency_key,payload_hash,response) values('booking',p_key,digest,result);
  return result;
end $$;
grant execute on function public.get_booking_configuration(uuid) to anon,authenticated;
grant execute on function public.create_public_reservation(uuid,uuid,date,time,text,text,text,integer,jsonb,uuid,text) to service_role;
commit;
