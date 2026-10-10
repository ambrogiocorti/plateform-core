
create or replace function private.takeaway_request_preview(
  p_venue uuid,
  p_pickup_date date,
  p_items jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_line jsonb;
  v_dish public.dishes;
  v_setting public.venue_dish_settings;
  v_qty integer;
  v_total_items integer:=0;
  v_subtotal bigint:=0;
  v_price bigint;
  v_removed uuid[];
  v_variants uuid[];
  v_group record;
begin
  perform private.takeaway_item_count(p_items);

  for v_line in
    select value from jsonb_array_elements(p_items)
  loop
    v_qty:=(v_line->>'quantity')::integer;

    select d.*
    into v_dish
    from public.dishes d
    join public.categories c on c.id=d.category_id and c.active
    where d.id=(v_line->>'dish_id')::uuid
      and d.active;

    if v_dish.id is null then
      raise exception 'DISH_UNAVAILABLE';
    end if;

    if not (
      v_dish.schedule_mode='ALWAYS'
      or (v_dish.schedule_mode='DATE' and v_dish.available_from=p_pickup_date)
      or (
        v_dish.schedule_mode='WEEKDAYS'
        and extract(isodow from p_pickup_date)::integer=any(v_dish.weekdays)
      )
      or (
        v_dish.schedule_mode='RANGE'
        and p_pickup_date between v_dish.available_from and v_dish.available_until
      )
    ) then
      raise exception 'DISH_UNAVAILABLE';
    end if;

    select *
    into v_setting
    from public.venue_dish_settings
    where venue_id=p_venue
      and dish_id=v_dish.id;

    if v_setting.dish_id is not null and not v_setting.enabled then
      raise exception 'DISH_UNAVAILABLE';
    end if;

    select coalesce(array_agg(x::uuid),'{}'::uuid[])
    into v_removed
    from jsonb_array_elements_text(
      coalesce(v_line->'removed_ingredients','[]'::jsonb)
    ) x;

    select coalesce(array_agg(x::uuid),'{}'::uuid[])
    into v_variants
    from jsonb_array_elements_text(
      coalesce(v_line->'variant_options','[]'::jsonb)
    ) x;

    if cardinality(v_removed)<>(
      select count(distinct x) from unnest(v_removed) x
    ) or cardinality(v_variants)<>(
      select count(distinct x) from unnest(v_variants) x
    ) then
      raise exception 'DUPLICATE_SELECTION';
    end if;

    if exists(
      select 1
      from unnest(v_removed) x
      where not exists(
        select 1
        from public.dish_ingredients
        where dish_id=v_dish.id
          and ingredient_id=x
          and removable
      )
    ) then
      raise exception 'INGREDIENT_NOT_REMOVABLE';
    end if;

    if not v_dish.beverage
       and not exists(
         select 1 from public.dish_ingredients where dish_id=v_dish.id
       ) then
      raise exception 'INGREDIENTS_REQUIRED';
    end if;

    if exists(
      select 1
      from unnest(v_variants) x
      where not exists(
        select 1
        from public.variant_options o
        join public.variant_groups g on g.id=o.group_id
        where o.id=x
          and o.active
          and g.active
          and g.dish_id=v_dish.id
      )
    ) then
      raise exception 'INVALID_VARIANT';
    end if;

    for v_group in
      select
        g.id,
        g.required,
        g.max_selections,
        (
          select count(*)
          from public.variant_options o
          where o.group_id=g.id and o.id=any(v_variants)
        ) as selected
      from public.variant_groups g
      where g.dish_id=v_dish.id and g.active
    loop
      if (v_group.required and v_group.selected=0)
         or v_group.selected>v_group.max_selections then
        raise exception 'VARIANT_SELECTION_REQUIRED';
      end if;
    end loop;

    v_price:=coalesce(v_setting.local_price_cents,v_dish.price_cents);
    v_total_items:=v_total_items+v_qty;
    v_subtotal:=v_subtotal+(v_qty*v_price);
  end loop;

  return jsonb_build_object(
    'item_count',v_total_items,
    'subtotal_cents',v_subtotal
  );
end
$$;

revoke all on function private.takeaway_request_preview(uuid,date,jsonb)
from public,anon,authenticated;
