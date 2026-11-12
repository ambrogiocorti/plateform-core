-- STEP 2.1: a mono-venue Admin must be able to manage the restaurant catalog without gaining cross-venue authority.
begin;
create function private.can_manage_shared_catalog() returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_role()='ADMIN' and (
    private.current_scope()='CHAIN'
    or (
      not coalesce((select licensed from public.feature_flags where name='MULTI_VENUE'),false)
      and (select count(*) from public.venues where active)=1
      and exists(select 1 from public.venues v where v.active and private.has_venue(v.id))
    )
  )
$$;
revoke all on function private.can_manage_shared_catalog() from public,anon,authenticated,service_role;

create or replace function private.save_configuration_unchecked(p_entity text,p_venue uuid,p_id uuid,p_values jsonb,p_version bigint default null) returns jsonb language plpgsql security definer set search_path='' as $$
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
  if not scoped and not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
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
revoke all on function private.save_configuration_unchecked(text,uuid,uuid,jsonb,bigint) from public,anon,authenticated,service_role;

create or replace function public.configure_dish(p_dish uuid,p_ingredients jsonb,p_tags uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
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

create or replace function public.configure_ingredient_allergens(p_ingredient uuid,p_allergens uuid[]) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.ingredients where id=p_ingredient for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  delete from public.ingredient_allergens where ingredient_id=p_ingredient;
  insert into public.ingredient_allergens(ingredient_id,allergen_id) select p_ingredient,unnest(p_allergens);
end $$;

create or replace function public.save_dish_composition(p_dish uuid,p_version bigint,p_ingredients jsonb,p_tags uuid[],p_variants jsonb,p_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.dishes; g jsonb; opt jsonb; group_ref uuid; option_id uuid; kept uuid[]:='{}'; kept_options uuid[]; result jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED'; end if;
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
commit;