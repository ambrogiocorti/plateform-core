CREATE OR REPLACE FUNCTION public.set_ingredient_cost(p_ingredient uuid, p_venue uuid, p_cost_micros bigint, p_purchase_unit text, p_effective_from timestamp with time zone, p_source text, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if p_venue is null then
    if not private.feature_licensed('FOOD_COST') then
      raise exception 'FEATURE_NOT_LICENSED';
    end if;
  else
    perform private.require_venue_feature(p_venue,'FOOD_COST');
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
$function$;

CREATE OR REPLACE FUNCTION public.get_dish_food_cost(p_dish uuid, p_venue uuid, p_at timestamp with time zone DEFAULT clock_timestamp())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dish public.dishes;
  v_actor uuid;
  v_line_count integer;
  v_recipe_complete boolean;
  v_cost_complete boolean;
  v_total_exact numeric;
  v_total_micros bigint;
  v_selling_micros bigint;
  v_lines jsonb;
begin
  if p_at is null or p_dish is null then
    raise exception 'INVALID_FOOD_COST_REQUEST';
  end if;

  if p_venue is null then
    v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
    if not private.can_manage_shared_catalog() then
      raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
    end if;
  else
    v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  end if;

  if p_venue is null then
    if not private.feature_licensed('FOOD_COST') then
      raise exception 'FEATURE_NOT_LICENSED';
    end if;
  else
    perform private.require_venue_feature(p_venue,'FOOD_COST');
  end if;

  select *
  into v_dish
  from public.dishes
  where id=p_dish;

  if v_dish.id is null then raise exception 'NOT_FOUND'; end if;

  with recipe as (
    select
      di.dish_id,
      di.ingredient_id,
      i.name as ingredient_name,
      di.quantity,
      di.unit,
      di.yield_factor,
      di.waste_percentage,
      case
        when di.quantity is null then null
        else di.quantity
             / coalesce(di.yield_factor,1)
             * (1 + coalesce(di.waste_percentage,0)/100)
      end as adjusted_quantity
    from public.dish_ingredients di
    join public.ingredients i on i.id=di.ingredient_id
    where di.dish_id=p_dish
  ),
  priced as (
    select
      r.*,
      c.id as cost_id,
      c.venue_id as cost_venue_id,
      c.cost_micros,
      c.purchase_unit,
      c.effective_from,
      c.effective_to,
      case
        when r.adjusted_quantity is null or c.id is null then null
        else private.convert_recipe_quantity(
               r.adjusted_quantity,
               r.unit,
               c.purchase_unit
             )
      end as purchase_quantity
    from recipe r
    left join lateral (
      select h.*
      from public.ingredient_cost_history h
      where h.ingredient_id=r.ingredient_id
        and h.effective_from<=p_at
        and (h.effective_to is null or p_at<h.effective_to)
        and (
          h.venue_id is not distinct from p_venue
          or h.venue_id is null
        )
      order by
        case when h.venue_id is not distinct from p_venue and p_venue is not null then 0 else 1 end,
        h.effective_from desc
      limit 1
    ) c on true
  ),
  finalized as (
    select *,
      case
        when purchase_quantity is null or cost_micros is null then null
        else purchase_quantity*cost_micros
      end as line_cost_exact
    from priced
  )
  select
    count(*)::integer,
    coalesce(bool_and(quantity is not null and unit is not null),false),
    coalesce(bool_and(
      quantity is not null
      and unit is not null
      and cost_id is not null
      and purchase_quantity is not null
    ),false),
    sum(line_cost_exact),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'ingredient_id',ingredient_id,
          'ingredient_name',ingredient_name,
          'quantity',quantity,
          'unit',unit,
          'yield_factor',yield_factor,
          'waste_percentage',waste_percentage,
          'adjusted_quantity',adjusted_quantity,
          'cost_source',case
            when cost_id is null then null
            when cost_venue_id is null then 'CHAIN'
            else 'VENUE'
          end,
          'purchase_unit',purchase_unit,
          'purchase_quantity',purchase_quantity,
          'cost_micros',cost_micros,
          'line_cost_micros',case
            when line_cost_exact is null then null
            else round(line_cost_exact)::bigint
          end
        )
        order by ingredient_name,ingredient_id
      ),
      '[]'::jsonb
    )
  into
    v_line_count,
    v_recipe_complete,
    v_cost_complete,
    v_total_exact,
    v_lines
  from finalized;

  v_recipe_complete:=v_line_count>0 and v_recipe_complete;
  v_cost_complete:=v_line_count>0 and v_recipe_complete and v_cost_complete;

  if v_cost_complete then
    v_total_micros:=round(v_total_exact)::bigint;
    v_selling_micros:=v_dish.price_cents*10000;
  end if;

  return jsonb_build_object(
    'dish_id',v_dish.id,
    'venue_id',p_venue,
    'as_of',p_at,
    'currency','EUR',
    'recipe_lines',v_line_count,
    'recipe_complete',v_recipe_complete,
    'cost_complete',v_cost_complete,
    'food_cost_micros',case when v_cost_complete then v_total_micros end,
    'food_cost_cents',case when v_cost_complete then round(v_total_micros/10000.0)::bigint end,
    'food_cost_percentage',case
      when v_cost_complete and v_selling_micros>0
      then round((v_total_micros::numeric/v_selling_micros::numeric)*100,4)
    end,
    'gross_margin_micros',case
      when v_cost_complete then v_selling_micros-v_total_micros
    end,
    'gross_margin_cents',case
      when v_cost_complete then round((v_selling_micros-v_total_micros)/10000.0)::bigint
    end,
    'gross_margin_percentage',case
      when v_cost_complete and v_selling_micros>0
      then round(((v_selling_micros-v_total_micros)::numeric/v_selling_micros::numeric)*100,4)
    end,
    'lines',v_lines
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.snapshot_dish_food_cost(p_dish uuid, p_venue uuid, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  v_result jsonb;
  v_cost jsonb;
  v_at timestamptz:=clock_timestamp();
  v_id uuid;
  v_price bigint;
begin
  if p_dish is null or p_venue is null or p_key is null then
    raise exception 'INVALID_FOOD_COST_SNAPSHOT';
  end if;

  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_venue_feature(p_venue,'FOOD_COST');

  v_result:=private.idempotency_begin(
    'dish_food_cost_snapshot',
    p_key,
    jsonb_build_object('dish',p_dish,'venue',p_venue)
  );
  if v_result is not null then return v_result; end if;

  select price_cents into v_price
  from public.dishes
  where id=p_dish;
  if v_price is null then raise exception 'NOT_FOUND'; end if;

  v_cost:=public.get_dish_food_cost(p_dish,p_venue,v_at);

  if not coalesce((v_cost->>'cost_complete')::boolean,false) then
    raise exception 'FOOD_COST_INCOMPLETE';
  end if;

  insert into public.dish_food_cost_snapshots(
    dish_id,venue_id,as_of,currency,selling_price_cents,
    food_cost_micros,food_cost_cents,food_cost_percentage,
    gross_margin_micros,gross_margin_cents,gross_margin_percentage,
    details,created_by
  ) values(
    p_dish,p_venue,(v_cost->>'as_of')::timestamptz,'EUR',v_price,
    (v_cost->>'food_cost_micros')::bigint,
    (v_cost->>'food_cost_cents')::bigint,
    (v_cost->>'food_cost_percentage')::numeric,
    (v_cost->>'gross_margin_micros')::bigint,
    (v_cost->>'gross_margin_cents')::bigint,
    (v_cost->>'gross_margin_percentage')::numeric,
    v_cost,
    v_actor
  )
  returning id into v_id;

  v_result:=jsonb_build_object('id',v_id,'snapshot',v_cost);
  return private.idempotency_finish('dish_food_cost_snapshot',p_key,v_result);
end
$function$;

CREATE OR REPLACE FUNCTION public.get_menu_engineering(p_venue uuid, p_start date, p_end date, p_category uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_cost_at timestamptz;
  v_result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  perform private.require_venue_feature(p_venue,'FOOD_COST');

  if p_venue is null
     or p_start is null
     or p_end is null
     or p_end<p_start
     or (p_end-p_start)>366
  then
    raise exception 'INVALID_ANALYTICS_RANGE';
  end if;

  select timezone into v_timezone
  from public.venues
  where id=p_venue and active;
  if v_timezone is null then raise exception 'NOT_FOUND'; end if;

  if p_category is not null
     and not exists(select 1 from public.categories where id=p_category) then
    raise exception 'CATEGORY_NOT_FOUND';
  end if;

  v_start:=p_start::timestamp at time zone v_timezone;
  v_end:=(p_end+1)::timestamp at time zone v_timezone;
  v_cost_at:=v_end-interval '1 microsecond';

  with sales as (
    select
      i.dish_id,
      count(*) filter(where u.voided_at is null)::bigint as units_sold,
      count(*) filter(where u.voided_at is not null)::bigint as voided_units,
      coalesce(sum(u.gross_cents-u.discount_cents)
        filter(where u.voided_at is null),0)::bigint as net_revenue_cents
    from public.billing_units u
    join public.order_items i on i.id=u.order_item_id
    join public.orders o on o.id=i.order_id
    where u.venue_id=p_venue
      and o.created_at>=v_start
      and o.created_at<v_end
    group by i.dish_id
  ),
  dish_scope as (
    select
      d.id as dish_id,
      d.name,
      d.category_id,
      c.name as category_name,
      d.price_cents,
      d.active
    from public.dishes d
    join public.categories c on c.id=d.category_id
    where (p_category is null or d.category_id=p_category)
      and (
        d.active
        or exists(select 1 from sales s where s.dish_id=d.id)
      )
  ),
  metrics as (
    select
      d.*,
      coalesce(s.units_sold,0)::bigint as units_sold,
      coalesce(s.voided_units,0)::bigint as voided_units,
      coalesce(s.net_revenue_cents,0)::bigint as net_revenue_cents,
      fc.cost
    from dish_scope d
    left join sales s on s.dish_id=d.dish_id
    left join lateral (
      select public.get_dish_food_cost(d.dish_id,p_venue,v_cost_at) as cost
    ) fc on true
  ),
  thresholds as (
    select
      avg(units_sold::numeric) as popularity_threshold,
      avg((cost->>'gross_margin_micros')::numeric)
        filter(where coalesce((cost->>'cost_complete')::boolean,false)) as margin_threshold_micros
    from metrics
  ),
  final as (
    select
      m.*,
      t.popularity_threshold,
      t.margin_threshold_micros,
      coalesce((m.cost->>'cost_complete')::boolean,false) as cost_complete,
      (m.cost->>'food_cost_micros')::bigint as food_cost_micros,
      (m.cost->>'food_cost_cents')::bigint as food_cost_cents,
      (m.cost->>'food_cost_percentage')::numeric as food_cost_percentage,
      (m.cost->>'gross_margin_micros')::bigint as gross_margin_micros,
      (m.cost->>'gross_margin_cents')::bigint as gross_margin_cents,
      (m.cost->>'gross_margin_percentage')::numeric as gross_margin_percentage
    from metrics m
    cross join thresholds t
  ),
  classified as (
    select
      f.*,
      private.classify_menu_engineering(
        f.units_sold::numeric,
        f.gross_margin_micros::numeric,
        f.popularity_threshold,
        f.margin_threshold_micros
      ) as classification,
      case
        when f.cost_complete then
          f.net_revenue_cents*10000 - f.units_sold*f.food_cost_micros
      end as period_contribution_margin_micros
    from final f
  )
  select jsonb_build_object(
    'venue_id',p_venue,
    'start_date',p_start,
    'end_date',p_end,
    'category_id',p_category,
    'cost_basis','PERIOD_END_THEORETICAL',
    'thresholds',jsonb_build_object(
      'popularity_units',coalesce((select popularity_threshold from thresholds),0),
      'gross_margin_micros',coalesce((select margin_threshold_micros from thresholds),0)
    ),
    'classification_counts',coalesce((
      select jsonb_object_agg(classification,cnt order by classification)
      from (
        select classification,count(*)::integer cnt
        from classified
        group by classification
      ) x
    ),'{}'::jsonb),
    'items',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'dish_id',dish_id,
          'name',name,
          'category_id',category_id,
          'category_name',category_name,
          'active',active,
          'selling_price_cents',price_cents,
          'units_sold',units_sold,
          'voided_units',voided_units,
          'net_revenue_cents',net_revenue_cents,
          'food_cost_complete',cost_complete,
          'food_cost_micros',food_cost_micros,
          'food_cost_cents',food_cost_cents,
          'food_cost_percentage',food_cost_percentage,
          'gross_margin_micros',gross_margin_micros,
          'gross_margin_cents',gross_margin_cents,
          'gross_margin_percentage',gross_margin_percentage,
          'period_contribution_margin_micros',period_contribution_margin_micros,
          'classification',classification
        )
        order by units_sold desc,net_revenue_cents desc,name
      )
      from classified
    ),'[]'::jsonb)
  )
  into v_result;

  return v_result;
end
$function$;

CREATE OR REPLACE FUNCTION public.configure_dish(p_dish uuid, p_ingredients jsonb, p_tags uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if exists(
    select 1
    from jsonb_array_elements(p_ingredients) e
    where e ? 'quantity'
       or e ? 'unit'
       or e ? 'yield_factor'
       or e ? 'waste_percentage'
  ) and not private.feature_licensed('FOOD_COST') then
    raise exception 'FEATURE_NOT_LICENSED';
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
$function$;

CREATE OR REPLACE FUNCTION private.menu_available_at(p_menu uuid, p_venue uuid, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_menu public.menus;
  v_timezone text;
  v_local timestamp;
  v_business_date date;
  v_local_time time;
  v_business_isodow integer;
begin
  if p_menu is null or p_venue is null or p_at is null then
    return false;
  end if;

  if not private.venue_feature_enabled(p_venue,'MULTI_MENU_QR') then
    return false;
  end if;

  select * into v_menu
  from public.menus
  where id=p_menu
    and active
    and published;

  if v_menu.id is null then
    return false;
  end if;

  if not exists(
    select 1
    from public.menu_venues mv
    join public.venues v on v.id=mv.venue_id and v.active
    where mv.menu_id=p_menu
      and mv.venue_id=p_venue
  ) then
    return false;
  end if;

  select timezone into v_timezone
  from public.venues
  where id=p_venue and active;

  if v_timezone is null then
    return false;
  end if;

  v_local:=p_at at time zone v_timezone;
  v_local_time:=v_local::time;
  v_business_date:=v_local::date;

  if v_menu.starts_at is not null
     and v_menu.ends_at is not null
     and v_menu.starts_at>v_menu.ends_at
     and v_local_time<v_menu.ends_at
  then
    v_business_date:=v_business_date-1;
  end if;

  if v_menu.available_from is not null
     and v_business_date<v_menu.available_from then
    return false;
  end if;

  if v_menu.available_until is not null
     and v_business_date>v_menu.available_until then
    return false;
  end if;

  v_business_isodow:=extract(isodow from v_business_date)::integer;

  if not (v_business_isodow=any(v_menu.weekdays)) then
    return false;
  end if;

  if v_menu.starts_at is null then
    return true;
  end if;

  if v_menu.starts_at=v_menu.ends_at then
    return true;
  elsif v_menu.starts_at<v_menu.ends_at then
    return v_local_time>=v_menu.starts_at
       and v_local_time<v_menu.ends_at;
  else
    return v_local_time>=v_menu.starts_at
       or v_local_time<v_menu.ends_at;
  end if;
end
$function$;

CREATE OR REPLACE FUNCTION public.save_menu(p_id uuid, p_version bigint, p_name text, p_slug text, p_active boolean, p_published boolean, p_weekdays integer[], p_starts_at time without time zone, p_ends_at time without time zone, p_available_from date, p_available_until date, p_sort_order integer, p_venues uuid[], p_categories uuid[], p_dishes uuid[], p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  v_result jsonb;
  v_menu public.menus;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_slug text:=lower(trim(p_slug));
  v_name text:=trim(p_name);
begin
  v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then
    raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
  end if;

  if not private.feature_licensed('MULTI_MENU_QR') then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  if p_key is null
     or v_name is null
     or length(v_name) not between 1 and 120
     or v_slug is null
     or length(v_slug) not between 2 and 80
     or v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or p_active is null
     or p_published is null
     or p_weekdays is null
     or cardinality(p_weekdays) not between 1 and 7
     or exists(select 1 from unnest(p_weekdays) d where d not between 1 and 7)
     or (p_starts_at is null)<>(p_ends_at is null)
     or (p_available_from is not null and p_available_until is not null and p_available_until<p_available_from)
     or p_sort_order is null
     or p_venues is null
     or p_categories is null
     or p_dishes is null
     or array_position(p_venues,null) is not null
     or array_position(p_categories,null) is not null
     or array_position(p_dishes,null) is not null
     or cardinality(p_venues)>100
     or cardinality(p_categories)>500
     or cardinality(p_dishes)>2000
  then
    raise exception 'INVALID_MENU';
  end if;

  if (select count(*) from unnest(p_venues) x)
     <> (select count(distinct x) from unnest(p_venues) x)
     or (select count(*) from unnest(p_categories) x)
     <> (select count(distinct x) from unnest(p_categories) x)
     or (select count(*) from unnest(p_dishes) x)
     <> (select count(distinct x) from unnest(p_dishes) x)
  then
    raise exception 'DUPLICATE_MENU_REFERENCE';
  end if;

  if p_published and (
       not p_active
       or cardinality(p_venues)=0
       or cardinality(p_categories)=0
       or cardinality(p_dishes)=0
     )
  then
    raise exception 'MENU_NOT_PUBLISHABLE';
  end if;

  if exists(
    select 1
    from unnest(p_venues) v(id)
    left join public.venues x on x.id=v.id and x.active
    where x.id is null
  ) then
    raise exception 'VENUE_NOT_FOUND';
  end if;

  if exists(
    select 1
    from unnest(p_venues) v(id)
    where not private.venue_feature_enabled(v.id,'MULTI_MENU_QR')
  ) then
    raise exception 'FEATURE_DISABLED';
  end if;

  if exists(
    select 1
    from unnest(p_categories) c(id)
    left join public.categories x on x.id=c.id and x.active
    where x.id is null
  ) then
    raise exception 'CATEGORY_NOT_FOUND';
  end if;

  if exists(
    select 1
    from unnest(p_dishes) d(id)
    left join public.dishes x on x.id=d.id
    where x.id is null
  ) then
    raise exception 'DISH_NOT_FOUND';
  end if;

  if exists(
    select 1
    from public.dishes d
    where d.id=any(p_dishes)
      and not (d.category_id=any(p_categories))
  ) then
    raise exception 'MENU_CATEGORY_REQUIRED';
  end if;

  if p_published and exists(
    select 1
    from public.dishes d
    where d.id=any(p_dishes)
      and not d.active
  ) then
    raise exception 'INACTIVE_DISH_IN_PUBLISHED_MENU';
  end if;

  v_result:=private.idempotency_begin(
    'menu_configuration',
    p_key,
    jsonb_build_object(
      'id',p_id,
      'version',p_version,
      'name',v_name,
      'slug',v_slug,
      'active',p_active,
      'published',p_published,
      'weekdays',p_weekdays,
      'starts_at',p_starts_at,
      'ends_at',p_ends_at,
      'available_from',p_available_from,
      'available_until',p_available_until,
      'sort_order',p_sort_order,
      'venues',p_venues,
      'categories',p_categories,
      'dishes',p_dishes
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.menus(
      id,name,slug,active,published,weekdays,starts_at,ends_at,
      available_from,available_until,sort_order
    ) values(
      v_id,v_name,v_slug,p_active,p_published,p_weekdays,p_starts_at,p_ends_at,
      p_available_from,p_available_until,p_sort_order
    )
    returning * into v_menu;
  else
    select * into v_menu
    from public.menus
    where id=p_id
    for update;

    if v_menu.id is null then raise exception 'NOT_FOUND'; end if;
    if p_version is null or v_menu.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.menus
    set name=v_name,
        slug=v_slug,
        active=p_active,
        published=p_published,
        weekdays=p_weekdays,
        starts_at=p_starts_at,
        ends_at=p_ends_at,
        available_from=p_available_from,
        available_until=p_available_until,
        sort_order=p_sort_order
    where id=p_id
    returning * into v_menu;
  end if;

  delete from public.menu_dishes where menu_id=v_id;
  delete from public.menu_categories where menu_id=v_id;
  delete from public.menu_venues where menu_id=v_id;

  insert into public.menu_venues(menu_id,venue_id,sort_order)
  select v_id,id,ord::integer
  from unnest(p_venues) with ordinality v(id,ord);

  insert into public.menu_categories(menu_id,category_id,sort_order)
  select v_id,id,ord::integer
  from unnest(p_categories) with ordinality c(id,ord);

  insert into public.menu_dishes(menu_id,dish_id,sort_order)
  select v_id,id,ord::integer
  from unnest(p_dishes) with ordinality d(id,ord);

  select * into v_menu from public.menus where id=v_id;

  v_result:=jsonb_build_object(
    'id',v_menu.id,
    'public_menu_id',v_menu.public_menu_id,
    'version',v_menu.version,
    'slug',v_menu.slug,
    'published',v_menu.published
  );

  return private.idempotency_finish('menu_configuration',p_key,v_result);
end
$function$;

CREATE OR REPLACE FUNCTION public.save_menu_promotion(p_id uuid, p_version bigint, p_venue uuid, p_menu uuid, p_display_mode text, p_title text, p_body text, p_image_path text, p_cta_label text, p_target_category uuid, p_target_dish uuid, p_target_menu uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_priority integer, p_max_impressions integer, p_active boolean, p_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  v_result jsonb;
  v_row public.menu_promotions;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_mode text:=upper(trim(p_display_mode));
  v_title text:=trim(p_title);
begin
  if p_venue is null then
    v_actor:=private.authorize(null,array['ADMIN']::public.user_role[]);
    if not private.can_manage_shared_catalog() then
      raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
    end if;
  else
    v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  end if;

  if p_venue is null then
    if not private.feature_licensed('MENU_PROMOTIONS') then
      raise exception 'FEATURE_NOT_LICENSED';
    end if;
  else
    perform private.require_venue_feature(p_venue,'MENU_PROMOTIONS');
  end if;

  if p_key is null
     or v_mode not in ('BANNER','CARD','BADGE','POPUP')
     or v_title is null
     or length(v_title) not between 1 and 160
     or (p_body is not null and length(p_body)>2000)
     or (p_image_path is not null and length(p_image_path)>500)
     or (p_cta_label is not null and length(trim(p_cta_label)) not between 1 and 80)
     or p_start_at is null
     or (p_end_at is not null and p_end_at<=p_start_at)
     or p_priority is null
     or p_priority not between -100000 and 100000
     or (p_max_impressions is not null and p_max_impressions not between 1 and 100)
     or p_active is null
     or num_nonnulls(p_target_category,p_target_dish,p_target_menu)>1
  then
    raise exception 'INVALID_PROMOTION';
  end if;

  if p_menu is not null then
    if not exists(select 1 from public.menus where id=p_menu) then
      raise exception 'MENU_NOT_FOUND';
    end if;

    if p_venue is not null and not exists(
      select 1 from public.menu_venues
      where menu_id=p_menu and venue_id=p_venue
    ) then
      raise exception 'MENU_VENUE_REQUIRED';
    end if;
  end if;

  if p_target_category is not null
     and not exists(select 1 from public.categories where id=p_target_category) then
    raise exception 'CATEGORY_NOT_FOUND';
  end if;

  if p_target_dish is not null
     and not exists(select 1 from public.dishes where id=p_target_dish) then
    raise exception 'DISH_NOT_FOUND';
  end if;

  if p_target_menu is not null
     and not exists(select 1 from public.menus where id=p_target_menu) then
    raise exception 'TARGET_MENU_NOT_FOUND';
  end if;

  if p_menu is not null
     and p_target_category is not null
     and not exists(
       select 1 from public.menu_categories
       where menu_id=p_menu and category_id=p_target_category
     ) then
    raise exception 'PROMOTION_TARGET_NOT_IN_MENU';
  end if;

  if p_menu is not null
     and p_target_dish is not null
     and not exists(
       select 1 from public.menu_dishes
       where menu_id=p_menu and dish_id=p_target_dish
     ) then
    raise exception 'PROMOTION_TARGET_NOT_IN_MENU';
  end if;

  if p_venue is not null
     and p_target_menu is not null
     and not exists(
       select 1 from public.menu_venues
       where menu_id=p_target_menu and venue_id=p_venue
     ) then
    raise exception 'TARGET_MENU_VENUE_REQUIRED';
  end if;

  v_result:=private.idempotency_begin(
    'menu_promotion',
    p_key,
    jsonb_build_object(
      'id',p_id,
      'version',p_version,
      'venue',p_venue,
      'menu',p_menu,
      'display_mode',v_mode,
      'title',v_title,
      'body',nullif(p_body,''),
      'image_path',nullif(p_image_path,''),
      'cta_label',nullif(trim(p_cta_label),''),
      'target_category',p_target_category,
      'target_dish',p_target_dish,
      'target_menu',p_target_menu,
      'start_at',p_start_at,
      'end_at',p_end_at,
      'priority',p_priority,
      'max_impressions',p_max_impressions,
      'active',p_active
    )
  );
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.menu_promotions(
      id,venue_id,menu_id,display_mode,title,body,image_path,cta_label,
      target_category_id,target_dish_id,target_menu_id,
      start_at,end_at,priority,max_impressions_per_session,active
    ) values(
      v_id,p_venue,p_menu,v_mode,v_title,nullif(p_body,''),nullif(p_image_path,''),
      nullif(trim(p_cta_label),''),
      p_target_category,p_target_dish,p_target_menu,
      p_start_at,p_end_at,p_priority,p_max_impressions,p_active
    )
    returning * into v_row;
  else
    select * into v_row
    from public.menu_promotions
    where id=p_id
    for update;

    if v_row.id is null then raise exception 'NOT_FOUND'; end if;

    if v_row.venue_id is distinct from p_venue then
      raise exception 'PROMOTION_SCOPE_IMMUTABLE';
    end if;

    if p_version is null or v_row.version<>p_version then
      raise exception 'VERSION_CONFLICT' using errcode='40001';
    end if;

    update public.menu_promotions
    set menu_id=p_menu,
        display_mode=v_mode,
        title=v_title,
        body=nullif(p_body,''),
        image_path=nullif(p_image_path,''),
        cta_label=nullif(trim(p_cta_label),''),
        target_category_id=p_target_category,
        target_dish_id=p_target_dish,
        target_menu_id=p_target_menu,
        start_at=p_start_at,
        end_at=p_end_at,
        priority=p_priority,
        max_impressions_per_session=p_max_impressions,
        active=p_active
    where id=p_id
    returning * into v_row;
  end if;

  v_result:=jsonb_build_object(
    'id',v_row.id,
    'version',v_row.version,
    'active',v_row.active,
    'start_at',v_row.start_at,
    'end_at',v_row.end_at
  );

  return private.idempotency_finish('menu_promotion',p_key,v_result);
end
$function$;

CREATE OR REPLACE FUNCTION private.public_menu_payload(p_menu uuid, p_venue uuid, p_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_menu public.menus;
  v_venue uuid;
  v_venue_count integer;
  v_timezone text;
  v_local_date date;
  v_result jsonb;
begin
  if p_menu is null or p_at is null then
    raise exception 'MENU_NOT_FOUND';
  end if;

  select * into v_menu
  from public.menus
  where id=p_menu;

  if v_menu.id is null then
    raise exception 'MENU_NOT_FOUND';
  end if;

  if p_venue is null then
    select count(*)::integer,
           (array_agg(mv.venue_id order by mv.venue_id))[1]
      into v_venue_count,v_venue
    from public.menu_venues mv
    join public.venues v on v.id=mv.venue_id and v.active
    where mv.menu_id=p_menu;

    if v_venue_count=0 then
      raise exception 'MENU_NOT_AVAILABLE';
    elsif v_venue_count>1 then
      raise exception 'VENUE_REQUIRED';
    end if;
  else
    v_venue:=p_venue;
  end if;

  if not private.menu_available_at(p_menu,v_venue,p_at) then
    raise exception 'MENU_NOT_AVAILABLE';
  end if;

  select timezone into v_timezone
  from public.venues
  where id=v_venue and active;

  v_local_date:=(p_at at time zone v_timezone)::date;

  with visible_items as (
    select
      d.id,d.name,d.description,d.image_path,d.beverage,d.category_id,
      c.name as category_name,
      coalesce(s.local_price_cents,d.price_cents) as price_cents,
      case
        when s.availability is null then null
        when s.availability_date=v_local_date then s.availability
        else 0
      end as availability,
      mc.sort_order as category_menu_sort,
      c.sort_order as category_sort,
      md.sort_order as dish_menu_sort,
      d.sort_order as dish_sort
    from public.menu_dishes md
    join public.dishes d on d.id=md.dish_id and d.active
    join public.menu_categories mc
      on mc.menu_id=md.menu_id
     and mc.category_id=d.category_id
    join public.categories c on c.id=d.category_id and c.active
    left join public.venue_dish_settings s
      on s.venue_id=v_venue and s.dish_id=d.id
    where md.menu_id=p_menu
      and coalesce(s.enabled,true)
      and (
        d.schedule_mode='ALWAYS'
        or (d.schedule_mode='DATE' and d.available_from=v_local_date)
        or (
          d.schedule_mode='WEEKDAYS'
          and extract(isodow from v_local_date)::integer=any(d.weekdays)
        )
        or (
          d.schedule_mode='RANGE'
          and v_local_date between d.available_from and d.available_until
        )
      )
  ),
  categories_payload as (
    select jsonb_agg(
      jsonb_build_object(
        'id',c.category_id,
        'name',c.category_name,
        'items',coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id',i.id,
              'name',i.name,
              'description',i.description,
              'image_path',i.image_path,
              'beverage',i.beverage,
              'price_cents',i.price_cents,
              'availability',i.availability,
              'ingredients',coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id',ing.id,'name',ing.name,'removable',di.removable
                  )
                  order by ing.name,ing.id
                )
                from public.dish_ingredients di
                join public.ingredients ing on ing.id=di.ingredient_id
                where di.dish_id=i.id
              ),'[]'::jsonb),
              'allergens',coalesce((
                select jsonb_agg(
                  jsonb_build_object('code',a.code,'name',a.name)
                  order by a.code
                )
                from public.allergens a
                where a.id in (
                  select ia.allergen_id
                  from public.ingredient_allergens ia
                  join public.dish_ingredients di
                    on di.ingredient_id=ia.ingredient_id
                  where di.dish_id=i.id
                )
              ),'[]'::jsonb),
              'dietary_tags',coalesce((
                select jsonb_agg(
                  jsonb_build_object('code',dt.code,'label',dt.label)
                  order by dt.code
                )
                from public.dietary_tags dt
                join public.dish_dietary_tags dd on dd.tag_id=dt.id
                where dd.dish_id=i.id
              ),'[]'::jsonb),
              'variant_groups',coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id',g.id,
                    'name',g.name,
                    'required',g.required,
                    'max_selections',g.max_selections,
                    'options',coalesce((
                      select jsonb_agg(
                        jsonb_build_object('id',o.id,'label',o.label)
                        order by o.label,o.id
                      )
                      from public.variant_options o
                      where o.group_id=g.id and o.active
                    ),'[]'::jsonb)
                  )
                  order by g.name,g.id
                )
                from public.variant_groups g
                where g.dish_id=i.id and g.active
              ),'[]'::jsonb)
            )
            order by i.dish_menu_sort,i.dish_sort,i.name,i.id
          )
          from visible_items i
          where i.category_id=c.category_id
        ),'[]'::jsonb)
      )
      order by c.category_menu_sort,c.category_sort,c.category_name,c.category_id
    ) as categories
    from (
      select distinct
        category_id,category_name,category_menu_sort,category_sort
      from visible_items
    ) c
  ),
  promotions_payload as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id',p.id,
        'display_mode',p.display_mode,
        'title',p.title,
        'body',p.body,
        'image_path',p.image_path,
        'cta_label',p.cta_label,
        'priority',p.priority,
        'max_impressions_per_session',p.max_impressions_per_session,
        'target',case
          when p.target_category_id is not null then
            jsonb_build_object('type','CATEGORY','id',p.target_category_id)
          when p.target_dish_id is not null then
            jsonb_build_object('type','DISH','id',p.target_dish_id)
          when p.target_menu_id is not null then
            jsonb_build_object(
              'type','MENU',
              'public_menu_id',tm.public_menu_id,
              'slug',tm.slug
            )
          else null
        end
      )
      order by p.priority desc,p.start_at desc,p.id
    ),'[]'::jsonb) as promotions
    from public.menu_promotions p
    left join public.menus tm on tm.id=p.target_menu_id
    where private.venue_feature_enabled(v_venue,'MENU_PROMOTIONS')
      and p.active
      and p.start_at<=p_at
      and (p.end_at is null or p_at<p.end_at)
      and (p.venue_id is null or p.venue_id=v_venue)
      and (p.menu_id is null or p.menu_id=p_menu)
      and (
        p.target_category_id is null
        or exists(
          select 1 from public.menu_categories mc
          where mc.menu_id=p_menu
            and mc.category_id=p.target_category_id
        )
      )
      and (
        p.target_dish_id is null
        or exists(
          select 1 from public.menu_dishes md
          where md.menu_id=p_menu
            and md.dish_id=p.target_dish_id
        )
      )
      and (
        p.target_menu_id is null
        or private.menu_available_at(p.target_menu_id,v_venue,p_at)
      )
  )
  select jsonb_build_object(
    'menu',jsonb_build_object(
      'public_menu_id',v_menu.public_menu_id,
      'name',v_menu.name,
      'slug',v_menu.slug
    ),
    'venue_id',v_venue,
    'generated_at',p_at,
    'categories',coalesce((select categories from categories_payload),'[]'::jsonb),
    'promotions',coalesce((select promotions from promotions_payload),'[]'::jsonb)
  )
  into v_result;

  return v_result;
end
$function$;