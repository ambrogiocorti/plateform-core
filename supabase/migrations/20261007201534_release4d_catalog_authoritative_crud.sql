
create or replace function public.save_category(
  p_id uuid,
  p_version bigint,
  p_name text,
  p_description text,
  p_sort_order integer,
  p_active boolean,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_current public.categories;
  v_result jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 120
     or coalesce(length(p_description),0)>2000 or p_sort_order is null or p_active is null
  then raise exception 'INVALID_CATEGORY'; end if;

  v_result:=private.idempotency_begin('category_configuration',p_key,jsonb_build_object(
    'id',p_id,'version',p_version,'name',trim(p_name),'description',nullif(trim(p_description),''),
    'sort_order',p_sort_order,'active',p_active
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.categories(id,name,description,sort_order,active)
    values(v_id,trim(p_name),nullif(trim(p_description),''),p_sort_order,p_active)
    returning * into v_current;
  else
    select * into v_current from public.categories where id=p_id for update;
    if v_current.id is null then raise exception 'NOT_FOUND'; end if;
    if v_current.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if not p_active and exists(select 1 from public.dishes where category_id=p_id and active) then
      raise exception 'CATEGORY_IN_USE';
    end if;
    update public.categories
    set name=trim(p_name),description=nullif(trim(p_description),''),sort_order=p_sort_order,active=p_active
    where id=p_id
    returning * into v_current;
  end if;

  v_result:=jsonb_build_object('id',v_current.id,'version',v_current.version);
  return private.idempotency_finish('category_configuration',p_key,v_result);
end
$$;

create or replace function public.save_ingredient(
  p_id uuid,
  p_version bigint,
  p_name text,
  p_active boolean,
  p_allergens uuid[],
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_current public.ingredients;
  v_result jsonb;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 160
     or p_active is null or p_allergens is null or array_position(p_allergens,null) is not null
     or cardinality(p_allergens)>50
  then raise exception 'INVALID_INGREDIENT'; end if;
  if (select count(*) from unnest(p_allergens) x)<>(select count(distinct x) from unnest(p_allergens) x)
     or exists(select 1 from unnest(p_allergens) x where not exists(select 1 from public.allergens a where a.id=x))
  then raise exception 'INVALID_ALLERGEN'; end if;

  v_result:=private.idempotency_begin('ingredient_configuration',p_key,jsonb_build_object(
    'id',p_id,'version',p_version,'name',trim(p_name),'active',p_active,'allergens',p_allergens
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.ingredients(id,name,active)
    values(v_id,trim(p_name),p_active)
    returning * into v_current;
  else
    select * into v_current from public.ingredients where id=p_id for update;
    if v_current.id is null then raise exception 'NOT_FOUND'; end if;
    if v_current.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if not p_active and exists(
      select 1 from public.dish_ingredients di
      join public.dishes d on d.id=di.dish_id
      where di.ingredient_id=p_id and d.active
    ) then raise exception 'INGREDIENT_IN_USE'; end if;
    update public.ingredients set name=trim(p_name),active=p_active where id=p_id returning * into v_current;
  end if;

  perform public.configure_ingredient_allergens(v_id,p_allergens);
  select * into v_current from public.ingredients where id=v_id;
  v_result:=jsonb_build_object('id',v_current.id,'version',v_current.version);
  return private.idempotency_finish('ingredient_configuration',p_key,v_result);
end
$$;

create or replace function public.save_station(
  p_venue uuid,
  p_id uuid,
  p_version bigint,
  p_name text,
  p_active boolean,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_current public.stations;
  v_result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 120 or p_active is null
  then raise exception 'INVALID_STATION'; end if;

  v_result:=private.idempotency_begin('station_configuration',p_key,jsonb_build_object(
    'venue',p_venue,'id',p_id,'version',p_version,'name',trim(p_name),'active',p_active
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.stations(id,venue_id,name,active)
    values(v_id,p_venue,trim(p_name),p_active)
    returning * into v_current;
  else
    select * into v_current from public.stations where id=p_id and venue_id=p_venue for update;
    if v_current.id is null then raise exception 'NOT_FOUND'; end if;
    if v_current.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if not p_active and exists(
      select 1 from public.dish_station_assignments a
      join public.venue_dish_settings s on s.venue_id=a.venue_id and s.dish_id=a.dish_id
      where a.station_id=p_id and a.venue_id=p_venue and s.enabled
    ) then raise exception 'STATION_IN_USE'; end if;
    update public.stations set name=trim(p_name),active=p_active where id=p_id returning * into v_current;
  end if;

  v_result:=jsonb_build_object('id',v_current.id,'version',v_current.version);
  return private.idempotency_finish('station_configuration',p_key,v_result);
end
$$;

create or replace function public.save_dish(
  p_id uuid,
  p_version bigint,
  p_category uuid,
  p_name text,
  p_description text,
  p_image_path text,
  p_beverage boolean,
  p_price_cents bigint,
  p_active boolean,
  p_sort_order integer,
  p_schedule_mode text,
  p_available_from date,
  p_available_until date,
  p_weekdays integer[],
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_current public.dishes;
  v_result jsonb;
  v_old_price bigint;
begin
  v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501'; end if;

  if p_key is null or p_category is null or p_name is null or length(trim(p_name)) not between 1 and 160
     or coalesce(length(p_description),0)>4000 or coalesce(length(p_image_path),0)>1024
     or (p_image_path is not null and p_image_path like '%://%')
     or p_beverage is null or p_price_cents is null or p_price_cents not between 0 and 100000000
     or p_active is null or p_sort_order is null or p_schedule_mode not in ('ALWAYS','DATE','WEEKDAYS','RANGE')
     or p_weekdays is null or array_position(p_weekdays,null) is not null
     or exists(select 1 from unnest(p_weekdays) d where d not between 1 and 7)
     or (select count(*) from unnest(p_weekdays) d)<>(select count(distinct d) from unnest(p_weekdays) d)
  then raise exception 'INVALID_DISH'; end if;

  if (p_schedule_mode='ALWAYS' and (p_available_from is not null or p_available_until is not null or cardinality(p_weekdays)<>0))
     or (p_schedule_mode='DATE' and (p_available_from is null or p_available_until is not null or cardinality(p_weekdays)<>0))
     or (p_schedule_mode='WEEKDAYS' and (p_available_from is not null or p_available_until is not null or cardinality(p_weekdays)=0))
     or (p_schedule_mode='RANGE' and (p_available_from is null or p_available_until is null or p_available_until<p_available_from or cardinality(p_weekdays)<>0))
  then raise exception 'INVALID_DISH_SCHEDULE'; end if;

  if not exists(select 1 from public.categories where id=p_category and active) then raise exception 'CATEGORY_NOT_FOUND'; end if;

  v_result:=private.idempotency_begin('dish_configuration',p_key,jsonb_build_object(
    'id',p_id,'version',p_version,'category',p_category,'name',trim(p_name),
    'description',nullif(trim(p_description),''),'image_path',nullif(trim(p_image_path),''),
    'beverage',p_beverage,'price',p_price_cents,'active',p_active,'sort_order',p_sort_order,
    'schedule_mode',p_schedule_mode,'available_from',p_available_from,'available_until',p_available_until,
    'weekdays',p_weekdays
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    if p_active and not p_beverage then raise exception 'DISH_INGREDIENTS_REQUIRED'; end if;
    insert into public.dishes(
      id,category_id,name,description,image_path,beverage,price_cents,active,sort_order,
      schedule_mode,available_from,available_until,weekdays
    ) values(
      v_id,p_category,trim(p_name),nullif(trim(p_description),''),nullif(trim(p_image_path),''),
      p_beverage,p_price_cents,p_active,p_sort_order,p_schedule_mode,p_available_from,p_available_until,p_weekdays
    ) returning * into v_current;
    insert into private.dish_price_history(dish_id,venue_id,source,old_price_cents,new_price_cents,changed_by)
    values(v_id,null,'BASE',null,p_price_cents,v_actor);
  else
    select * into v_current from public.dishes where id=p_id for update;
    if v_current.id is null then raise exception 'NOT_FOUND'; end if;
    if v_current.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if p_active and not p_beverage and not exists(select 1 from public.dish_ingredients where dish_id=p_id) then
      raise exception 'DISH_INGREDIENTS_REQUIRED';
    end if;
    v_old_price:=v_current.price_cents;
    update public.dishes
    set category_id=p_category,name=trim(p_name),description=nullif(trim(p_description),''),
        image_path=nullif(trim(p_image_path),''),beverage=p_beverage,price_cents=p_price_cents,
        active=p_active,sort_order=p_sort_order,schedule_mode=p_schedule_mode,
        available_from=p_available_from,available_until=p_available_until,weekdays=p_weekdays
    where id=p_id returning * into v_current;
    if v_old_price is distinct from p_price_cents then
      insert into private.dish_price_history(dish_id,venue_id,source,old_price_cents,new_price_cents,changed_by)
      values(p_id,null,'BASE',v_old_price,p_price_cents,v_actor);
    end if;
  end if;

  v_result:=jsonb_build_object('id',v_current.id,'version',v_current.version);
  return private.idempotency_finish('dish_configuration',p_key,v_result);
end
$$;

create or replace function public.save_venue_dish(
  p_venue uuid,
  p_dish uuid,
  p_version bigint,
  p_enabled boolean,
  p_price bigint,
  p_availability integer,
  p_primary_station uuid,
  p_observers uuid[],
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  current_version bigint;
  v_old_price bigint;
  result jsonb;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('venue_dish',p_key,jsonb_build_object(
    'venue',p_venue,'dish',p_dish,'version',p_version,'enabled',p_enabled,'price',p_price,
    'stock',p_availability,'primary',p_primary_station,'observers',p_observers
  ));
  if result is not null then return result; end if;

  perform 1 from public.dishes where id=p_dish for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select version,local_price_cents into current_version,v_old_price
  from public.venue_dish_settings
  where venue_id=p_venue and dish_id=p_dish
  for update;

  if current_version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  if p_primary_station is null
     or not exists(select 1 from public.stations where id=p_primary_station and venue_id=p_venue and active)
     or exists(select 1 from unnest(p_observers) x where not exists(select 1 from public.stations where id=x and venue_id=p_venue and active))
  then raise exception 'STATION_REQUIRED'; end if;

  perform public.configure_venue_dish(p_venue,p_dish,p_enabled,p_price,p_availability,p_primary_station,p_observers);

  if v_old_price is distinct from p_price then
    insert into private.dish_price_history(dish_id,venue_id,source,old_price_cents,new_price_cents,changed_by)
    values(p_dish,p_venue,'VENUE',v_old_price,p_price,v_actor);
  end if;

  select to_jsonb(s) into result
  from public.venue_dish_settings s
  where venue_id=p_venue and dish_id=p_dish;
  return private.idempotency_finish('venue_dish',p_key,result);
end
$$;

create or replace function public.get_dish_price_history(
  p_dish uuid,
  p_venue uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);
  if not exists(select 1 from public.dishes where id=p_dish) then raise exception 'NOT_FOUND'; end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',h.id,'source',h.source,'venue_id',h.venue_id,
        'old_price_cents',h.old_price_cents,'new_price_cents',h.new_price_cents,
        'changed_at',h.changed_at
      )
      order by h.changed_at desc,h.id desc
    )
    from private.dish_price_history h
    where h.dish_id=p_dish
      and (h.venue_id is null or h.venue_id=p_venue)
  ),'[]'::jsonb);
end
$$;

revoke all on function public.save_category(uuid,bigint,text,text,integer,boolean,uuid) from public,anon;
revoke all on function public.save_ingredient(uuid,bigint,text,boolean,uuid[],uuid) from public,anon;
revoke all on function public.save_station(uuid,uuid,bigint,text,boolean,uuid) from public,anon;
revoke all on function public.save_dish(uuid,bigint,uuid,text,text,text,boolean,bigint,boolean,integer,text,date,date,integer[],uuid) from public,anon;
revoke all on function public.get_dish_price_history(uuid,uuid) from public,anon;

grant execute on function public.save_category(uuid,bigint,text,text,integer,boolean,uuid) to authenticated,service_role;
grant execute on function public.save_ingredient(uuid,bigint,text,boolean,uuid[],uuid) to authenticated,service_role;
grant execute on function public.save_station(uuid,uuid,bigint,text,boolean,uuid) to authenticated,service_role;
grant execute on function public.save_dish(uuid,bigint,uuid,text,text,text,boolean,bigint,boolean,integer,text,date,date,integer[],uuid) to authenticated,service_role;
grant execute on function public.get_dish_price_history(uuid,uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
('public.save_category(uuid,bigint,text,text,integer,boolean,uuid)','authenticated'),
('public.save_ingredient(uuid,bigint,text,boolean,uuid[],uuid)','authenticated'),
('public.save_station(uuid,uuid,bigint,text,boolean,uuid)','authenticated'),
('public.save_dish(uuid,bigint,uuid,text,text,text,boolean,bigint,boolean,integer,text,date,date,integer[],uuid)','authenticated'),
('public.get_dish_price_history(uuid,uuid)','authenticated')
on conflict do nothing;
