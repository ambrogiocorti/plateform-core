begin;
create function private.validate_booking_edit(p_venue uuid,p_service uuid,p_date date,p_time time,p_party integer,p_exclude uuid default null) returns public.reservation_status language plpgsql security definer set search_path='' as $$
declare v public.venues;s public.services;rules public.service_booking_rules;day_rule public.booking_time_slots;slot public.booking_time_slots;total bigint;arrivals bigint;covers bigint;start_minutes int;end_minutes int;selected_minutes int;
begin
  perform private.require_booking_enabled(p_venue);select * into v from public.venues where id=p_venue and active and operational_status='OPEN';if v.id is null then raise exception 'RESERVATIONS_DISABLED';end if;
  select * into s from public.services where id=p_service and venue_id=p_venue and active for update;select * into rules from public.service_booking_rules where service_id=s.id;
  if s.id is null or rules.service_id is null then raise exception 'SERVICE_UNAVAILABLE';end if;
  if p_party is null or p_party not between 1 and 1000 or p_date is null or p_date<(now() at time zone v.timezone)::date or p_date>(now() at time zone v.timezone)::date+180 or not extract(isodow from p_date)::int=any(s.weekdays) then raise exception 'BOOKING_DATE_UNAVAILABLE';end if;
  start_minutes:=extract(epoch from s.starts_at)::int/60;end_minutes:=extract(epoch from s.ends_at)::int/60;selected_minutes:=extract(epoch from p_time)::int/60;
  if end_minutes<=start_minutes then end_minutes:=end_minutes+1440;if selected_minutes<start_minutes then selected_minutes:=selected_minutes+1440;end if;end if;
  if p_time is null or extract(second from p_time)<>0 or selected_minutes<start_minutes or selected_minutes>=end_minutes or (selected_minutes-start_minutes)%rules.slot_interval_minutes<>0 then raise exception 'BOOKING_SLOT_UNAVAILABLE';end if;
  if (p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone<=now() and p_exclude is null then raise exception 'BOOKING_IN_PAST';end if;
  if ((p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone) at time zone v.timezone<>p_date+make_interval(mins=>selected_minutes) then raise exception 'NONEXISTENT_LOCAL_TIME';end if;
  select * into day_rule from public.booking_time_slots where service_id=s.id and service_date=p_date and slot_time is null;select * into slot from public.booking_time_slots where service_id=s.id and service_date=p_date and slot_time=p_time;
  if coalesce(day_rule.closed,false) or coalesce(slot.closed,false) then raise exception 'BOOKING_CLOSED';end if;
  select coalesce(sum(party_size),0),count(*) filter(where slot_time=p_time),coalesce(sum(party_size) filter(where slot_time=p_time),0) into total,arrivals,covers from public.reservations where service_id=s.id and service_date=p_date and id is distinct from p_exclude and status not in ('CANCELLED','NO_SHOW');
  if total+p_party>coalesce(day_rule.max_covers_override,rules.max_covers_service) or arrivals+1>coalesce(slot.max_arrivals_override,rules.max_arrivals_per_slot) or covers+p_party>coalesce(slot.max_covers_override,rules.max_covers_per_slot) then raise exception 'BOOKING_CAPACITY_REACHED';end if;
  return case when p_party>rules.max_party_size_auto_confirm then 'REQUESTED'::public.reservation_status else 'RESERVED'::public.reservation_status end;
end $$;
create function private.validate_booking_answers(p_venue uuid,p_answers jsonb,p_existing uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare answer record; f public.reservation_form_fields;
begin if p_answers is null or jsonb_typeof(p_answers)<>'object' or pg_column_size(p_answers)>16384 then raise exception 'INVALID_FORM_ANSWERS';end if;
  if exists(select 1 from public.reservation_form_fields fld join public.reservation_form_definitions d on d.id=fld.form_id where d.venue_id=p_venue and d.active and fld.visible and fld.required and
    ((not p_answers ? fld.id::text and not exists(select 1 from public.reservation_answers ra where ra.reservation_id=p_existing and ra.field_id=fld.id and ra.answer not in ('null','""','[]','false'))) or p_answers->fld.id::text in ('null','""','[]','false'))) then raise exception 'FORM_REQUIRED_FIELDS';end if;
  for answer in select key,value from jsonb_each(p_answers) loop
    select fld.* into f from public.reservation_form_fields fld join public.reservation_form_definitions d on d.id=fld.form_id where fld.id::text=answer.key and d.venue_id=p_venue and d.active and fld.visible;
    if f.id is null then raise exception 'UNKNOWN_FORM_FIELD';end if;
    if answer.value='null'::jsonb and not f.required then continue;end if;
    if f.type in ('select','radio') and not f.options @> jsonb_build_array(answer.value) then raise exception 'INVALID_FORM_OPTION';end if;
    if f.type='number' and jsonb_typeof(answer.value)<>'number' then raise exception 'INVALID_FORM_NUMBER';end if;
    if f.type='checkbox' and ((jsonb_array_length(f.options)=0 and jsonb_typeof(answer.value)<>'boolean') or (jsonb_array_length(f.options)>0 and (jsonb_typeof(answer.value)<>'array' or not f.options @> answer.value))) then raise exception 'INVALID_FORM_CHECKBOX';end if;
    if f.type in ('text','textarea','tel','date','time') and (jsonb_typeof(answer.value)<>'string' or length(answer.value#>>'{}')>2000) then raise exception 'INVALID_FORM_TEXT';end if;
    if f.type='date' and (answer.value#>>'{}')<>'' then perform (answer.value#>>'{}')::date;end if;if f.type='time' and (answer.value#>>'{}')<>'' then perform (answer.value#>>'{}')::time;end if;
  end loop;
end $$;
create function public.save_staff_reservation(p_venue uuid,p_id uuid,p_version bigint,p_values jsonb,p_answers jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.reservations;ref uuid;booking_status public.reservation_status;result jsonb;answer_row record;service_ref uuid;
begin perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[]);
  result:=private.idempotency_begin('staff_reservation',p_key,jsonb_build_object('venue',p_venue,'id',p_id,'version',p_version,'values',p_values,'answers',p_answers));if result is not null then return result;end if;
  if p_values is null or not p_values ?& array['service_id','service_date','slot_time','first_name','last_name','phone','party_size'] or p_values-array['service_id','service_date','slot_time','first_name','last_name','phone','party_size','customer_note','internal_note','allergies']<>'{}'
    or p_values->>'first_name' is null or length(trim(p_values->>'first_name')) not between 1 and 100 or p_values->>'last_name' is null or length(p_values->>'last_name')>100 or p_values->>'phone' is null or p_values->>'phone' !~ '^\+[0-9]{7,15}$'
    or coalesce(length(p_values->>'customer_note'),0)>2000 or coalesce(length(p_values->>'internal_note'),0)>2000 or coalesce(length(p_values->>'allergies'),0)>2000 then raise exception 'INVALID_BOOKING_DETAILS';end if;
  service_ref:=(p_values->>'service_id')::uuid;perform private.lock_floor(p_venue);
  select * into r from public.reservations where id=p_id;
  if p_id is not null and (r.id is null or r.venue_id<>p_venue) then raise exception 'NOT_FOUND';end if;
  perform 1 from public.services where id in(service_ref,r.service_id) order by id for update;
  if p_id is not null then
    select * into r from public.reservations where id=p_id for update;
    if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
    if r.status not in ('REQUESTED','RESERVED','ARRIVED') or r.walk_in then raise exception 'RESERVATION_NOT_EDITABLE';end if;
    if r.table_id is not null and (r.service_id<>service_ref or r.service_date<>(p_values->>'service_date')::date or r.slot_time<>(p_values->>'slot_time')::time) then raise exception 'ASSIGNED_TABLE_SCHEDULE_LOCKED';end if;
    if r.table_id is not null and (p_values->>'party_size')::int>(select sum(seats) from public.tables where id=any(private.table_group(r.table_id))) then raise exception 'TABLE_CAPACITY_INSUFFICIENT';end if;
  end if;
  booking_status:=private.validate_booking_edit(p_venue,service_ref,(p_values->>'service_date')::date,(p_values->>'slot_time')::time,(p_values->>'party_size')::int,p_id);
  perform private.validate_booking_answers(p_venue,p_answers,p_id);
  if p_id is null then
    insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status,customer_note,internal_note,allergies)
      values(p_venue,service_ref,(p_values->>'service_date')::date,(p_values->>'slot_time')::time,trim(p_values->>'first_name'),trim(p_values->>'last_name'),p_values->>'phone',(p_values->>'party_size')::int,booking_status,p_values->>'customer_note',p_values->>'internal_note',p_values->>'allergies') returning id into ref;
  else
    update public.reservations set service_id=service_ref,service_date=(p_values->>'service_date')::date,slot_time=(p_values->>'slot_time')::time,first_name=trim(p_values->>'first_name'),last_name=trim(p_values->>'last_name'),phone=p_values->>'phone',party_size=(p_values->>'party_size')::int,customer_note=p_values->>'customer_note',internal_note=p_values->>'internal_note',allergies=p_values->>'allergies' where id=r.id;ref:=r.id;
  end if;
  for answer_row in select key,value from jsonb_each(p_answers) loop insert into public.reservation_answers(venue_id,reservation_id,field_id,answer) values(p_venue,ref,answer_row.key::uuid,answer_row.value) on conflict(reservation_id,field_id) do update set answer=excluded.answer;end loop;
  perform private.audit('RESERVATION_DETAILS_SAVED','reservations',ref,p_venue,jsonb_build_object('version',r.version),jsonb_build_object('status',coalesce(r.status,booking_status)));
  return private.idempotency_finish('staff_reservation',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.save_staff_reservation(uuid,uuid,bigint,jsonb,jsonb,uuid) to authenticated;
create function public.get_reservation_details(p_reservation uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reservations;
begin select * into r from public.reservations where id=p_reservation;if r.id is null then raise exception 'NOT_FOUND';end if;perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[],false);
  perform private.audit('RESERVATION_PRIVATE_READ','reservations',r.id,r.venue_id);
  return jsonb_build_object('reservation',to_jsonb(r),'answers',coalesce((select jsonb_object_agg(field_id::text,answer) from public.reservation_answers where reservation_id=r.id),'{}'));
end $$;
-- This RPC audits PII access, so it is volatile despite returning a snapshot.
alter function public.get_reservation_details(uuid) volatile;
grant execute on function public.get_reservation_details(uuid) to authenticated;
create or replace function public.create_public_reservation(p_venue uuid,p_service uuid,p_date date,p_time time,p_first_name text,p_last_name text,p_phone text,p_party integer,p_answers jsonb,p_key uuid,p_rate_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.venues; s public.services; rules public.service_booking_rules; slot public.booking_time_slots; day_rule public.booking_time_slots;
  total integer; arrivals integer; covers integer; start_minutes integer; selected_minutes integer; end_minutes integer;
  booking_status public.reservation_status; ref uuid; duplicate private.public_requests; digest text; answer record; form_field public.reservation_form_fields; result jsonb;
begin
  if not private.check_rate_limit('booking:'||p_rate_key,10,600) then return jsonb_build_object('error','RATE_LIMITED'); end if;
  if length(p_rate_key) not between 32 and 128 or p_key is null then raise exception 'INVALID_REQUEST'; end if;
  digest:=encode(extensions.digest(jsonb_build_object('venue',p_venue,'service',p_service,'date',p_date,'time',p_time,'first',p_first_name,'last',p_last_name,'phone',p_phone,'party',p_party,'answers',p_answers)::text,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('booking:'||p_key::text,0));
  select * into duplicate from private.public_requests where operation='booking' and idempotency_key=p_key;
  if found then
    if duplicate.payload_hash<>digest then raise exception 'IDEMPOTENCY_MISMATCH'; end if;
    return duplicate.response;
  end if;
  select * into v from public.venues where id=p_venue and active and operational_status='OPEN';
  if v.id is null or not private.installation_active() or not exists(select 1 from public.venue_settings where venue_id=v.id and reservations_enabled) then raise exception 'RESERVATIONS_DISABLED'; end if;
  select * into s from public.services where id=p_service and venue_id=v.id and active for update;
  select * into rules from public.service_booking_rules where service_id=s.id;
  if s.id is null or rules.service_id is null then raise exception 'SERVICE_UNAVAILABLE'; end if;
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
  if ((p_date+make_interval(mins=>selected_minutes)) at time zone v.timezone) at time zone v.timezone<>p_date+make_interval(mins=>selected_minutes) then raise exception 'NONEXISTENT_LOCAL_TIME';end if;
  booking_status:='RESERVED';
  if p_party>rules.max_party_size_auto_confirm then
    if rules.large_party_mode='REJECT' then raise exception 'CONTACT_RESTAURANT_FOR_LARGE_PARTY'; end if;
    booking_status:='REQUESTED';
  end if;
  perform private.validate_booking_answers(v.id,p_answers);
  insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status)
    values(v.id,s.id,p_date,p_time,trim(p_first_name),trim(p_last_name),p_phone,p_party,booking_status) returning id into ref;
  for answer in select key,value from jsonb_each(p_answers) loop
    select f.* into form_field from public.reservation_form_fields f join public.reservation_form_definitions d on d.id=f.form_id
      where f.id::text=answer.key and d.venue_id=v.id and d.active and f.visible;
    if form_field.id is null then raise exception 'UNKNOWN_FORM_FIELD'; end if;
    if answer.value='null'::jsonb and not form_field.required then continue;end if;
    insert into public.reservation_answers(venue_id,reservation_id,field_id,answer) values(v.id,ref,form_field.id,answer.value);
  end loop;
  insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id) values(v.id,'HOST','RESERVATION','Nuova prenotazione','reservations',ref);
  result:=jsonb_build_object('id',ref,'status',booking_status);
  insert into private.public_requests(operation,idempotency_key,payload_hash,response) values('booking',p_key,digest,result);
  return result;
end $$;
commit;
