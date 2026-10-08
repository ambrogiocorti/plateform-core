begin;
create function private.idempotency_begin(p_operation text,p_key uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare row_data private.idempotency_keys; actor uuid := auth.uid(); digest text;
begin
  if actor is null or p_key is null then raise exception 'AUTH_AND_IDEMPOTENCY_REQUIRED' using errcode='42501'; end if;
  digest := encode(extensions.digest(p_payload::text,'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(actor::text||p_operation||p_key::text,0));
  select * into row_data from private.idempotency_keys where actor_id=actor and operation=p_operation and key=p_key;
  if found then
    if row_data.payload_hash<>digest then raise exception 'IDEMPOTENCY_MISMATCH' using errcode='22023'; end if;
    return row_data.response;
  end if;
  insert into private.idempotency_keys(actor_id,operation,key,payload_hash) values(actor,p_operation,p_key,digest);
  return null;
end $$;
create function private.idempotency_finish(p_operation text,p_key uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  update private.idempotency_keys set response=p_result where actor_id=auth.uid() and operation=p_operation and key=p_key;
  if not found then raise exception 'IDEMPOTENCY_MISSING'; end if;
  return p_result;
end $$;

create function public.setup_installation(p_name text,p_public_url text,p_staff_url text,p_identity_domain text,p_venue jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v uuid;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  perform pg_advisory_xact_lock(71467001);
  if exists(select 1 from public.restaurant_profile) then raise exception 'ALREADY_CONFIGURED' using errcode='23505'; end if;
  if p_public_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$' or p_staff_url !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$' then raise exception 'HTTPS_ORIGIN_REQUIRED'; end if;
  insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain) values(p_name,p_public_url,p_staff_url,p_identity_domain);
  insert into public.restaurant_settings(id) values(true);
  insert into public.system_limits(id) values(true);
  insert into public.venues(name,slug,code,address,phone,timezone,currency,locale)
    values(p_venue->>'name',p_venue->>'slug',p_venue->>'code',p_venue->>'address',p_venue->>'phone',
    coalesce(p_venue->>'timezone','Europe/Rome'),coalesce(p_venue->>'currency','EUR'),coalesce(p_venue->>'locale','it-IT')) returning id into v;
  insert into public.venue_settings(venue_id) values(v);
  return v;
end $$;

create function public.configure_feature(p_name text,p_licensed boolean,p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'FEATURE_CHANGE');
  perform 1 from public.restaurant_profile where id for update;
  update public.feature_flags set licensed=p_licensed where name=p_name;
  if not found then raise exception 'UNKNOWN_FEATURE'; end if;
end $$;

create function public.set_installation_status(p_status public.installation_status,p_step_up uuid,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare current_status public.installation_status;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'INSTALLATION_STATUS');
  if length(trim(p_reason))<8 then raise exception 'REASON_REQUIRED'; end if;
  select status into current_status from public.restaurant_profile where id for update;
  if not ((current_status='ACTIVE' and p_status='SUSPENDED') or (current_status='SUSPENDED' and p_status='ACTIVE')) then raise exception 'INVALID_TRANSITION'; end if;
  update public.restaurant_profile set status=p_status where id;
end $$;

-- Explicit allowlists bound the generic configuration editor. No operational/economic entity is writable here.
create function public.save_configuration(p_entity text,p_venue uuid,p_id uuid,p_values jsonb,p_version bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare allowed text[]; columns_sql text; selections_sql text; updates_sql text; result jsonb; previous jsonb;
  key_column text := 'id'; actor uuid; scoped boolean := true; data jsonb := p_values; row_id uuid := coalesce(p_id,gen_random_uuid());
begin
  actor := private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if jsonb_typeof(p_values)<>'object' or p_values='{}'::jsonb then raise exception 'INVALID_PAYLOAD'; end if;
  case p_entity
    when 'rooms' then allowed:=array['name','active'];
    when 'room_layouts' then allowed:=array['room_id','name','active','archived','width','height','elements'];
    when 'zones' then allowed:=array['room_id','name','color','active'];
    when 'tables' then allowed:=array['room_id','layout_id','zone_id','number','name','seats','shape','position_x','position_y','width','height','rotation','active'];
    when 'stations' then allowed:=array['name','active'];
    when 'services' then allowed:=array['name','starts_at','ends_at','weekdays','active'];
    when 'categories' then allowed:=array['name','description','sort_order','active']; scoped:=false;
    when 'dishes' then allowed:=array['category_id','name','description','image_path','beverage','price_cents','active','sort_order','schedule_mode','available_from','available_until','weekdays']; scoped:=false;
    when 'ingredients' then allowed:=array['name','active']; scoped:=false;
    when 'allergens' then allowed:=array['code','name']; scoped:=false;
    when 'dietary_tags' then allowed:=array['code','label']; scoped:=false;
    when 'variant_groups' then allowed:=array['dish_id','name','required','max_selections','active']; scoped:=false;
    when 'variant_options' then allowed:=array['group_id','label','active']; scoped:=false;
    when 'print_devices' then allowed:=array['name','driver','endpoint','active','allowed_roles','configuration'];
    when 'cash_registers' then allowed:=array['name','code','location','active','printer_id','configuration'];
    when 'reservation_form_definitions' then allowed:=array['name','active'];
    when 'reservation_form_fields' then allowed:=array['form_id','key','type','label','placeholder','required','sort_order','options','visible'];
    when 'booking_time_slots' then allowed:=array['service_id','service_date','slot_time','closed','max_covers_override','max_arrivals_override','reason'];
    when 'shifts' then allowed:=array['staff_id','starts_at','ends_at'];
    else raise exception 'CONFIGURATION_ENTITY_FORBIDDEN' using errcode='42501';
  end case;
  if not scoped and private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  if scoped and p_venue is null then raise exception 'VENUE_REQUIRED'; end if;
  if exists(select 1 from jsonb_object_keys(p_values) k where not k=any(allowed)) then raise exception 'UNKNOWN_FIELD' using errcode='22023'; end if;
  if p_id is not null then
    execute format('select to_jsonb(t) from public.%I t where id=$1 for update',p_entity) into previous using p_id;
    if previous is null then raise exception 'NOT_FOUND'; end if;
    if scoped and (previous->>'venue_id')::uuid<>p_venue then raise exception 'VENUE_FORBIDDEN' using errcode='42501'; end if;
    if previous ? 'version' and (p_version is null or (previous->>'version')::bigint<>p_version) then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if p_entity='tables' and exists(select 1 from public.accounts where table_id=p_id and status<>'CLOSED') then raise exception 'TABLE_IN_SERVICE'; end if;
    if p_entity='cash_registers' and exists(select 1 from public.cash_register_sessions where cash_register_id=p_id and closed_at is null) then raise exception 'REGISTER_IN_SERVICE'; end if;
  end if;
  perform 1 from public.system_limits where id for update;
  if p_entity='tables' and p_id is null and (select count(*) from public.tables where venue_id=p_venue and active)>=(select max_tables_per_venue from public.system_limits where id) then raise exception 'TABLE_LIMIT'; end if;
  if p_entity='dishes' and p_id is null and (select count(*) from public.dishes where active)>=(select max_dishes from public.system_limits where id) then raise exception 'DISH_LIMIT'; end if;
  if p_id is null then
    data := data || jsonb_build_object(key_column,row_id);
    if scoped then data:=data||jsonb_build_object('venue_id',p_venue); end if;
    select string_agg(format('%I',k),','),string_agg(format('r.%I',k),',') into columns_sql,selections_sql from jsonb_object_keys(data) k;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I.*)',p_entity,columns_sql,selections_sql,p_entity,p_entity) into result using data;
  else
    select string_agg(format('%I=r.%I',k,k),',') into updates_sql from jsonb_object_keys(data) k;
    execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 returning to_jsonb(t)',p_entity,updates_sql,p_entity) into result using data,p_id;
  end if;
  return result;
end $$;

create function public.configure_dish(p_dish uuid,p_ingredients jsonb,p_tags uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.dishes where id=p_dish for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if jsonb_typeof(p_ingredients)<>'array' or jsonb_array_length(p_ingredients)>100 then raise exception 'INVALID_INGREDIENTS'; end if;
  if jsonb_array_length(p_ingredients)=0 and not (select beverage from public.dishes where id=p_dish) then raise exception 'INGREDIENTS_REQUIRED'; end if;
  delete from public.dish_ingredients where dish_id=p_dish;
  for item in select value from jsonb_array_elements(p_ingredients) loop
    insert into public.dish_ingredients(dish_id,ingredient_id,removable) values(p_dish,(item->>'ingredient_id')::uuid,coalesce((item->>'removable')::boolean,false));
  end loop;
  delete from public.dish_dietary_tags where dish_id=p_dish;
  insert into public.dish_dietary_tags(dish_id,tag_id) select p_dish,unnest(p_tags);
end $$;

create function public.configure_ingredient_allergens(p_ingredient uuid,p_allergens uuid[]) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.ingredients where id=p_ingredient for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  delete from public.ingredient_allergens where ingredient_id=p_ingredient;
  insert into public.ingredient_allergens(ingredient_id,allergen_id) select p_ingredient,unnest(p_allergens);
end $$;

create function public.configure_venue_dish(p_venue uuid,p_dish uuid,p_enabled boolean,p_price bigint,p_availability integer,p_primary_station uuid,p_observer_stations uuid[]) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform 1 from public.dishes where id=p_dish for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_primary_station=any(p_observer_stations) then raise exception 'PRIMARY_CANNOT_OBSERVE'; end if;
  insert into public.venue_dish_settings(venue_id,dish_id,enabled,local_price_cents,availability,availability_date,local_station_id)
    values(p_venue,p_dish,p_enabled,p_price,p_availability,(now() at time zone (select timezone from public.venues where id=p_venue))::date,p_primary_station)
    on conflict(venue_id,dish_id) do update set enabled=excluded.enabled,local_price_cents=excluded.local_price_cents,
      availability=excluded.availability,availability_date=excluded.availability_date,local_station_id=excluded.local_station_id;
  delete from public.dish_station_assignments where venue_id=p_venue and dish_id=p_dish;
  insert into public.dish_station_assignments(venue_id,dish_id,station_id,is_primary) values(p_venue,p_dish,p_primary_station,true);
  insert into public.dish_station_assignments(venue_id,dish_id,station_id,is_primary) select p_venue,p_dish,unnest(p_observer_stations),false;
end $$;

create function public.assign_waiter(p_venue uuid,p_waiter uuid,p_mode text,p_table uuid default null,p_zone uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if not exists(select 1 from public.staff_profiles p where p.id=p_waiter and p.role='WAITER' and p.active and
    (p.scope='CHAIN' or exists(select 1 from public.staff_venue_assignments s where s.user_id=p.id and s.venue_id=p_venue and s.active))) then raise exception 'WAITER_SCOPE_INVALID'; end if;
  perform 1 from public.venues where id=p_venue for update;
  if p_mode='TABLE' then update public.table_assignments set active=false where table_id=p_table and active;
  elsif p_mode='ZONE' then update public.table_assignments set active=false where zone_id=p_zone and active;
  end if;
  insert into public.table_assignments(venue_id,waiter_id,mode,table_id,zone_id) values(p_venue,p_waiter,p_mode,p_table,p_zone) returning id into result;
  update public.waiter_calls c set assigned_waiter_id=private.responsible_waiter(c.table_id) where c.venue_id=p_venue and c.status<>'COMPLETED';
  return result;
end $$;

grant execute on function public.setup_installation(text,text,text,text,jsonb),public.configure_feature(text,boolean,uuid),public.set_installation_status(public.installation_status,uuid,text),
  public.save_configuration(text,uuid,uuid,jsonb,bigint),public.configure_dish(uuid,jsonb,uuid[]),public.configure_ingredient_allergens(uuid,uuid[]),
  public.configure_venue_dish(uuid,uuid,boolean,bigint,integer,uuid,uuid[]),public.assign_waiter(uuid,uuid,text,uuid,uuid) to authenticated;
commit;
