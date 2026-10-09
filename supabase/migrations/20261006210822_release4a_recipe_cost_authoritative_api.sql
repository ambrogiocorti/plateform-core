
create or replace function private.recipe_unit_dimension(p_unit text)
returns text
language sql
immutable
set search_path=''
as $$
  select case p_unit
    when 'G' then 'MASS'
    when 'KG' then 'MASS'
    when 'ML' then 'VOLUME'
    when 'L' then 'VOLUME'
    when 'PIECE' then 'COUNT'
  end
$$;

create or replace function private.recipe_unit_factor_to_base(p_unit text)
returns numeric
language sql
immutable
set search_path=''
as $$
  select case p_unit
    when 'G' then 1::numeric
    when 'KG' then 1000::numeric
    when 'ML' then 1::numeric
    when 'L' then 1000::numeric
    when 'PIECE' then 1::numeric
  end
$$;

create or replace function private.convert_recipe_quantity(
  p_quantity numeric,
  p_from_unit text,
  p_to_unit text
)
returns numeric
language plpgsql
immutable
set search_path=''
as $$
declare
  v_from_dimension text;
  v_to_dimension text;
  v_from_factor numeric;
  v_to_factor numeric;
begin
  if p_quantity is null or p_quantity < 0 then
    raise exception 'INVALID_QUANTITY';
  end if;

  v_from_dimension:=private.recipe_unit_dimension(p_from_unit);
  v_to_dimension:=private.recipe_unit_dimension(p_to_unit);

  if v_from_dimension is null or v_to_dimension is null then
    raise exception 'INVALID_UNIT';
  end if;

  if v_from_dimension<>v_to_dimension then
    raise exception 'INCOMPATIBLE_UNITS';
  end if;

  v_from_factor:=private.recipe_unit_factor_to_base(p_from_unit);
  v_to_factor:=private.recipe_unit_factor_to_base(p_to_unit);

  return (p_quantity*v_from_factor)/v_to_factor;
end
$$;

revoke all on function private.recipe_unit_dimension(text) from public,anon,authenticated;
revoke all on function private.recipe_unit_factor_to_base(text) from public,anon,authenticated;
revoke all on function private.convert_recipe_quantity(numeric,text,text) from public,anon,authenticated;

create or replace function public.configure_dish(
  p_dish uuid,
  p_ingredients jsonb,
  p_tags uuid[]
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  item jsonb;
  v_ingredient uuid;
  v_quantity numeric;
  v_unit text;
  v_yield numeric;
  v_waste numeric;
  v_removable boolean;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then
    raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
  end if;

  perform 1 from public.dishes where id=p_dish for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  if jsonb_typeof(p_ingredients)<>'array'
     or jsonb_array_length(p_ingredients)>100 then
    raise exception 'INVALID_INGREDIENTS';
  end if;

  if jsonb_array_length(p_ingredients)=0
     and not (select beverage from public.dishes where id=p_dish) then
    raise exception 'INGREDIENTS_REQUIRED';
  end if;

  if (
    select count(*)<>count(distinct value->>'ingredient_id')
    from jsonb_array_elements(p_ingredients)
  ) then
    raise exception 'DUPLICATE_INGREDIENT';
  end if;

  delete from public.dish_ingredients where dish_id=p_dish;

  for item in select value from jsonb_array_elements(p_ingredients) loop
    if jsonb_typeof(item)<>'object'
       or coalesce(item->>'ingredient_id','') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'INVALID_INGREDIENT';
    end if;

    v_ingredient:=(item->>'ingredient_id')::uuid;
    v_removable:=coalesce((item->>'removable')::boolean,false);
    v_quantity:=case when item ? 'quantity' and item->>'quantity' is not null
                     then (item->>'quantity')::numeric end;
    v_unit:=nullif(upper(trim(item->>'unit')),'');
    v_yield:=case when item ? 'yield_factor' and item->>'yield_factor' is not null
                  then (item->>'yield_factor')::numeric end;
    v_waste:=case when item ? 'waste_percentage' and item->>'waste_percentage' is not null
                  then (item->>'waste_percentage')::numeric end;

    if not exists(select 1 from public.ingredients where id=v_ingredient and active) then
      raise exception 'INGREDIENT_NOT_FOUND';
    end if;

    if (v_quantity is null)<>(v_unit is null)
       or (v_quantity is not null and v_quantity<=0)
       or (v_unit is not null and private.recipe_unit_dimension(v_unit) is null)
       or (v_yield is not null and (v_yield<=0 or v_yield>1))
       or (v_waste is not null and (v_waste<0 or v_waste>=100))
       or ((v_yield is not null or v_waste is not null) and v_quantity is null)
    then
      raise exception 'INVALID_RECIPE_LINE';
    end if;

    if v_unit is not null and exists(
      select 1
      from public.dish_ingredients di
      where di.ingredient_id=v_ingredient
        and di.quantity is not null
        and private.recipe_unit_dimension(di.unit)<>private.recipe_unit_dimension(v_unit)
    ) then
      raise exception 'INGREDIENT_UNIT_DIMENSION_MISMATCH';
    end if;

    if v_unit is not null and exists(
      select 1
      from public.ingredient_cost_history c
      where c.ingredient_id=v_ingredient
        and private.recipe_unit_dimension(c.purchase_unit)<>private.recipe_unit_dimension(v_unit)
    ) then
      raise exception 'INGREDIENT_COST_UNIT_MISMATCH';
    end if;

    insert into public.dish_ingredients(
      dish_id,ingredient_id,removable,quantity,unit,yield_factor,waste_percentage
    ) values(
      p_dish,v_ingredient,v_removable,v_quantity,v_unit,v_yield,v_waste
    );
  end loop;

  delete from public.dish_dietary_tags where dish_id=p_dish;
  insert into public.dish_dietary_tags(dish_id,tag_id)
  select p_dish,unnest(coalesce(p_tags,'{}'::uuid[]));
end
$$;

create or replace function public.set_ingredient_cost(
  p_ingredient uuid,
  p_venue uuid,
  p_cost_micros bigint,
  p_purchase_unit text,
  p_effective_from timestamptz,
  p_source text,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_unit text:=upper(trim(p_purchase_unit));
  v_result jsonb;
  v_id uuid;
  v_current public.ingredient_cost_history;
begin
  if p_venue is null then
    v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
    if not private.can_manage_shared_catalog() then
      raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
    end if;
  else
    v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  end if;

  if p_key is null
     or p_ingredient is null
     or p_cost_micros is null
     or p_cost_micros<=0
     or p_effective_from is null
     or private.recipe_unit_dimension(v_unit) is null
     or (p_source is not null and length(trim(p_source)) not between 1 and 160)
  then
    raise exception 'INVALID_INGREDIENT_COST';
  end if;

  v_result:=private.idempotency_begin(
    'ingredient_cost',
    p_key,
    jsonb_build_object(
      'ingredient',p_ingredient,
      'venue',p_venue,
      'cost_micros',p_cost_micros,
      'purchase_unit',v_unit,
      'effective_from',p_effective_from,
      'source',nullif(trim(p_source),'')
    )
  );
  if v_result is not null then return v_result; end if;

  perform 1
  from public.ingredients
  where id=p_ingredient and active
  for update;
  if not found then raise exception 'INGREDIENT_NOT_FOUND'; end if;

  if exists(
    select 1
    from public.dish_ingredients di
    where di.ingredient_id=p_ingredient
      and di.quantity is not null
      and private.recipe_unit_dimension(di.unit)<>private.recipe_unit_dimension(v_unit)
  ) then
    raise exception 'INGREDIENT_RECIPE_UNIT_MISMATCH';
  end if;

  select *
    into v_current
  from public.ingredient_cost_history
  where ingredient_id=p_ingredient
    and venue_id is not distinct from p_venue
    and effective_to is null
  for update;

  if v_current.id is not null then
    if p_effective_from<=v_current.effective_from then
      raise exception 'COST_EFFECTIVE_ORDER';
    end if;

    update public.ingredient_cost_history
    set effective_to=p_effective_from
    where id=v_current.id;
  end if;

  insert into public.ingredient_cost_history(
    ingredient_id,venue_id,cost_micros,currency,purchase_unit,
    effective_from,source,created_by
  ) values(
    p_ingredient,p_venue,p_cost_micros,'EUR',v_unit,
    p_effective_from,nullif(trim(p_source),''),v_actor
  )
  returning id into v_id;

  v_result:=jsonb_build_object('id',v_id);
  return private.idempotency_finish('ingredient_cost',p_key,v_result);
end
$$;

revoke all on function public.set_ingredient_cost(uuid,uuid,bigint,text,timestamptz,text,uuid)
from public,anon;
grant execute on function public.set_ingredient_cost(uuid,uuid,bigint,text,timestamptz,text,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.set_ingredient_cost(uuid,uuid,bigint,text,timestamptz,text,uuid)','authenticated')
on conflict do nothing;
