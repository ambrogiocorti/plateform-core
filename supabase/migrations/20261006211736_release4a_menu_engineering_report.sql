
create or replace function public.get_menu_engineering(
  p_venue uuid,
  p_start date,
  p_end date,
  p_category uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_timezone text;
  v_start timestamptz;
  v_end timestamptz;
  v_cost_at timestamptz;
  v_result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

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
$$;

revoke all on function public.get_menu_engineering(uuid,date,date,uuid)
from public,anon;
grant execute on function public.get_menu_engineering(uuid,date,date,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_menu_engineering(uuid,date,date,uuid)','authenticated')
on conflict do nothing;
