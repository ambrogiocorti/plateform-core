
create or replace function public.get_dish_food_cost(
  p_dish uuid,
  p_venue uuid,
  p_at timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
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
$$;

revoke all on function public.get_dish_food_cost(uuid,uuid,timestamptz)
from public,anon;
grant execute on function public.get_dish_food_cost(uuid,uuid,timestamptz)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_dish_food_cost(uuid,uuid,timestamp with time zone)','authenticated')
on conflict do nothing;
