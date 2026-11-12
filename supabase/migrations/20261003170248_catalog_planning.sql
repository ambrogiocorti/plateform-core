begin;
-- All catalog edits share the dish lock used by order creation. Stock edits require
-- a revision and cannot restore stock consumed after the form was opened.
create function public.save_configuration_command(p_entity text,p_venue uuid,p_id uuid,p_values jsonb,p_version bigint,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('configuration',p_key,jsonb_build_object('entity',p_entity,'venue',p_venue,'id',p_id,'values',p_values,'version',p_version));
  if result is not null then return result; end if;
  result:=public.save_configuration(p_entity,p_venue,p_id,p_values,p_version);
  return private.idempotency_finish('configuration',p_key,result);
end $$;
grant execute on function public.save_configuration_command(text,uuid,uuid,jsonb,bigint,uuid) to authenticated;

create function private.enforce_active_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare maximum integer; current_count integer;
begin
  if not new.active or (tg_op='UPDATE' and old.active) then return new; end if;
  perform 1 from public.system_limits where id for update;
  if tg_table_name='dishes' then
    select max_dishes into maximum from public.system_limits where id;
    select count(*) into current_count from public.dishes where active and id<>new.id;
  elsif tg_table_name='tables' then
    select max_tables_per_venue into maximum from public.system_limits where id;
    select count(*) into current_count from public.tables where active and venue_id=new.venue_id and id<>new.id;
  else
    select max_users into maximum from public.system_limits where id;
    select count(*) into current_count from public.staff_profiles where active and id<>new.id;
  end if;
  if current_count>=maximum then raise exception 'ACTIVE_ENTITY_LIMIT'; end if;
  return new;
end $$;
create trigger active_quota before insert or update on public.dishes for each row execute function private.enforce_active_quota();
create trigger active_quota before insert or update on public.tables for each row execute function private.enforce_active_quota();
create trigger active_quota before insert or update on public.staff_profiles for each row execute function private.enforce_active_quota();

create function public.save_dish_composition(p_dish uuid,p_version bigint,p_ingredients jsonb,p_tags uuid[],p_variants jsonb,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.dishes; g jsonb; opt jsonb; group_ref uuid; option_id uuid; kept uuid[]:='{}'; kept_options uuid[]; result jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED'; end if;
  result:=private.idempotency_begin('dish_composition',p_key,jsonb_build_object('dish',p_dish,'version',p_version,'ingredients',p_ingredients,'tags',p_tags,'variants',p_variants));
  if result is not null then return result; end if;
  select * into d from public.dishes where id=p_dish for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  if p_version is distinct from d.version then raise exception 'VERSION_CONFLICT'; end if;
  if p_variants is null or jsonb_typeof(p_variants)<>'array' or jsonb_array_length(p_variants)>20 then raise exception 'INVALID_VARIANTS'; end if;
  perform public.configure_dish(p_dish,p_ingredients,p_tags);
  for g in select value from jsonb_array_elements(p_variants) loop
    if g-array['id','name','required','max_selections','options']<>'{}'::jsonb or length(trim(g->>'name')) not between 1 and 120
      or jsonb_typeof(g->'options') is distinct from 'array' or jsonb_array_length(g->'options') not between 1 and 50 then raise exception 'INVALID_VARIANTS'; end if;
    group_ref:=coalesce(nullif(g->>'id','')::uuid,gen_random_uuid());
    if group_ref=any(kept) or exists(select 1 from public.variant_groups where id=group_ref and dish_id<>d.id) then raise exception 'INVALID_VARIANTS'; end if;
    kept:=array_append(kept,group_ref); kept_options:='{}';
    insert into public.variant_groups(id,dish_id,name,required,max_selections) values(group_ref,d.id,trim(g->>'name'),coalesce((g->>'required')::boolean,false),(g->>'max_selections')::integer)
      on conflict(id) do update set name=excluded.name,required=excluded.required,max_selections=excluded.max_selections,active=true;
    for opt in select value from jsonb_array_elements(g->'options') loop
      if opt-array['id','label']<>'{}'::jsonb or length(trim(opt->>'label')) not between 1 and 120 then raise exception 'INVALID_VARIANTS'; end if;
      option_id:=coalesce(nullif(opt->>'id','')::uuid,gen_random_uuid());
      if option_id=any(kept_options) or exists(select 1 from public.variant_options where id=option_id and group_id<>group_ref) then raise exception 'INVALID_VARIANTS'; end if;
      kept_options:=array_append(kept_options,option_id);
      insert into public.variant_options(id,group_id,label) values(option_id,group_ref,trim(opt->>'label'))
        on conflict(id) do update set label=excluded.label,active=true;
    end loop;
    update public.variant_options set active=false where public.variant_options.group_id=group_ref and not id=any(kept_options);
  end loop;
  update public.variant_groups set active=false where dish_id=d.id and not id=any(kept);
  update public.dishes set updated_at=now() where id=d.id returning to_jsonb(public.dishes.*) into result;
  perform private.audit('DISH_COMPOSITION_SAVED','dishes',d.id,null,jsonb_build_object('version',d.version),jsonb_build_object('version',(result->>'version')::bigint));
  return private.idempotency_finish('dish_composition',p_key,result);
end $$;
grant execute on function public.save_dish_composition(uuid,bigint,jsonb,uuid[],jsonb,uuid) to authenticated;

create function public.save_venue_dish(p_venue uuid,p_dish uuid,p_version bigint,p_enabled boolean,p_price bigint,p_availability integer,p_primary_station uuid,p_observers uuid[],p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_version bigint; result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('venue_dish',p_key,jsonb_build_object('venue',p_venue,'dish',p_dish,'version',p_version,'enabled',p_enabled,'price',p_price,'stock',p_availability,'primary',p_primary_station,'observers',p_observers));
  if result is not null then return result; end if;
  perform 1 from public.dishes where id=p_dish for update;
  select version into current_version from public.venue_dish_settings where venue_id=p_venue and dish_id=p_dish for update;
  if current_version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_primary_station is null or not exists(select 1 from public.stations where id=p_primary_station and venue_id=p_venue and active)
    or exists(select 1 from unnest(p_observers) x where not exists(select 1 from public.stations where id=x and venue_id=p_venue and active)) then raise exception 'STATION_REQUIRED'; end if;
  perform public.configure_venue_dish(p_venue,p_dish,p_enabled,p_price,p_availability,p_primary_station,p_observers);
  select to_jsonb(s) into result from public.venue_dish_settings s where venue_id=p_venue and dish_id=p_dish;
  return private.idempotency_finish('venue_dish',p_key,result);
end $$;
revoke execute on function public.configure_venue_dish(uuid,uuid,boolean,bigint,integer,uuid,uuid[]) from authenticated;
grant execute on function public.save_venue_dish(uuid,uuid,bigint,boolean,bigint,integer,uuid,uuid[],uuid) to authenticated;

create function public.save_shift(p_venue uuid,p_id uuid,p_staff uuid,p_start timestamptz,p_end timestamptz,p_version bigint,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; row_ref public.shifts;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('shift',p_key,jsonb_build_object('venue',p_venue,'id',p_id,'staff',p_staff,'start',p_start,'end',p_end,'version',p_version));
  if result is not null then return result; end if;
  perform 1 from public.staff_profiles where id=p_staff for update;
  if not private.staff_has_venue(p_staff,p_venue) then raise exception 'STAFF_VENUE_FORBIDDEN'; end if;
  if p_start is null or p_end is null or p_end<=p_start or p_end-p_start>interval '24 hours' then raise exception 'INVALID_SHIFT'; end if;
  if exists(select 1 from public.shifts where staff_id=p_staff and id is distinct from p_id and tstzrange(starts_at,ends_at,'[)')&&tstzrange(p_start,p_end,'[)')) then raise exception 'SHIFT_OVERLAP'; end if;
  if p_id is null then
    insert into public.shifts(venue_id,staff_id,starts_at,ends_at) values(p_venue,p_staff,p_start,p_end) returning * into row_ref;
  else
    select * into row_ref from public.shifts where id=p_id and venue_id=p_venue for update;
    if row_ref.id is null or row_ref.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
    update public.shifts set staff_id=p_staff,starts_at=p_start,ends_at=p_end where id=p_id returning * into row_ref;
  end if;
  return private.idempotency_finish('shift',p_key,to_jsonb(row_ref));
end $$;
grant execute on function public.save_shift(uuid,uuid,uuid,timestamptz,timestamptz,bigint,uuid) to authenticated;

create function public.save_booking_slot(p_venue uuid,p_service uuid,p_date date,p_time time,p_closed boolean,p_covers integer,p_arrivals integer,p_reason text,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; ref uuid;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if not exists(select 1 from public.services where id=p_service and venue_id=p_venue) or p_reason is null or length(trim(p_reason))<3 then raise exception 'INVALID_BOOKING_DETAILS'; end if;
  result:=private.idempotency_begin('booking_slot',p_key,jsonb_build_object('venue',p_venue,'service',p_service,'date',p_date,'time',p_time,'closed',p_closed,'covers',p_covers,'arrivals',p_arrivals,'reason',p_reason));
  if result is not null then return result; end if;
  perform 1 from public.services where id=p_service for update;
  insert into public.booking_time_slots(venue_id,service_id,service_date,slot_time,closed,max_covers_override,max_arrivals_override,reason)
    values(p_venue,p_service,p_date,p_time,p_closed,p_covers,p_arrivals,trim(p_reason))
    on conflict(service_id,service_date,slot_time) do update set closed=excluded.closed,max_covers_override=excluded.max_covers_override,max_arrivals_override=excluded.max_arrivals_override,reason=excluded.reason returning id into ref;
  perform private.audit('BOOKING_CAPACITY_OVERRIDE','booking_time_slots',ref,p_venue,null,jsonb_build_object('closed',p_closed,'max_covers',p_covers,'max_arrivals',p_arrivals,'reason',p_reason));
  return private.idempotency_finish('booking_slot',p_key,jsonb_build_object('id',ref));
end $$;
grant execute on function public.save_booking_slot(uuid,uuid,date,time,boolean,integer,integer,text,uuid) to authenticated;
commit;
begin;
create function public.save_shift_local(p_venue uuid,p_id uuid,p_staff uuid,p_start timestamp,p_end timestamp,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare tz text; start_utc timestamptz; end_utc timestamptz;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  select timezone into tz from public.venues where id=p_venue;
  start_utc:=p_start at time zone tz; end_utc:=p_end at time zone tz;
  if (start_utc at time zone tz)<>p_start or (end_utc at time zone tz)<>p_end then raise exception 'NONEXISTENT_LOCAL_TIME'; end if;
  return public.save_shift(p_venue,p_id,p_staff,start_utc,end_utc,p_version,p_key);
end $$;
grant execute on function public.save_shift_local(uuid,uuid,uuid,timestamp,timestamp,bigint,uuid) to authenticated;

create function public.save_reservation_form(p_venue uuid,p_id uuid,p_version bigint,p_name text,p_fields jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare f jsonb; form_ref uuid; result jsonb; current_version bigint; kept uuid[]:='{}'; field_ref uuid;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('reservation_form',p_key,jsonb_build_object('venue',p_venue,'id',p_id,'version',p_version,'name',p_name,'fields',p_fields));
  if result is not null then return result; end if;
  if p_fields is null or jsonb_typeof(p_fields)<>'array' or jsonb_array_length(p_fields)>50 or p_name is null or length(trim(p_name)) not between 1 and 120 then raise exception 'INVALID_FORM'; end if;
  perform 1 from public.venues where id=p_venue for update;
  if p_id is null then
    if exists(select 1 from public.reservation_form_definitions where venue_id=p_venue and active) then raise exception 'FORM_ALREADY_EXISTS'; end if;
    insert into public.reservation_form_definitions(venue_id,name) values(p_venue,p_name) returning id into form_ref;
  else
    select version into current_version from public.reservation_form_definitions where id=p_id and venue_id=p_venue and active for update;
    if current_version is null or current_version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
    form_ref:=p_id;
    update public.reservation_form_definitions set name=p_name where id=p_id;
  end if;
  for f in select value from jsonb_array_elements(p_fields) loop
    if f-array['id','key','type','label','placeholder','required','sort_order','options','visible']<>'{}'::jsonb or (f->>'key') !~ '^[a-z][a-z0-9_]{0,49}$' or length(trim(f->>'label')) not between 1 and 120
      or jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options')>50 then raise exception 'INVALID_FORM'; end if;
    field_ref:=coalesce(nullif(f->>'id','')::uuid,gen_random_uuid());
    if field_ref=any(kept) or exists(select 1 from public.reservation_form_fields where id=field_ref and form_id<>form_ref) then raise exception 'INVALID_FORM'; end if;
    kept:=array_append(kept,field_ref);
    insert into public.reservation_form_fields(id,venue_id,form_id,key,type,label,placeholder,required,sort_order,options,visible)
      values(field_ref,p_venue,form_ref,f->>'key',f->>'type',trim(f->>'label'),f->>'placeholder',coalesce((f->>'required')::boolean,false),(f->>'sort_order')::integer,f->'options',coalesce((f->>'visible')::boolean,true))
      on conflict(id) do update set type=excluded.type,label=excluded.label,placeholder=excluded.placeholder,required=excluded.required,sort_order=excluded.sort_order,options=excluded.options,visible=excluded.visible;
  end loop;
  -- Keep historical answers attached to their original fields; removed fields are hidden.
  update public.reservation_form_fields set visible=false,required=false where form_id=form_ref and not id=any(kept);
  perform private.audit('RESERVATION_FORM_SAVED','reservation_form_definitions',form_ref,p_venue);
  select to_jsonb(d) into result from public.reservation_form_definitions d where id=form_ref;
  return private.idempotency_finish('reservation_form',p_key,result);
end $$;
grant execute on function public.save_reservation_form(uuid,uuid,bigint,text,jsonb,uuid) to authenticated;
commit;
