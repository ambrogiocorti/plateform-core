
create or replace function private.public_menu_payload(
  p_menu uuid,
  p_venue uuid,
  p_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
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

  perform private.require_venue_feature(
    v_venue,
    'MULTI_MENU_QR'
  );

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
                    'id',ing.id,
                    'name',ing.name,
                    'removable',di.removable
                  )
                  order by ing.name,ing.id
                )
                from public.dish_ingredients di
                join public.ingredients ing on ing.id=di.ingredient_id
                where di.dish_id=i.id
              ),'[]'::jsonb),
              'allergens',coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'code',a.code,
                    'name',a.name
                  )
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
                  jsonb_build_object(
                    'code',dt.code,
                    'label',dt.label
                  )
                  order by dt.code
                )
                from public.dietary_tags dt
                join public.dish_dietary_tags dd
                  on dd.tag_id=dt.id
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
                        jsonb_build_object(
                          'id',o.id,
                          'label',o.label
                        )
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
    select coalesce(
      jsonb_agg(
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
              jsonb_build_object(
                'type','CATEGORY',
                'id',p.target_category_id
              )
            when p.target_dish_id is not null then
              jsonb_build_object(
                'type','DISH',
                'id',p.target_dish_id
              )
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
      ),
      '[]'::jsonb
    ) as promotions
    from public.menu_promotions p
    left join public.menus tm on tm.id=p.target_menu_id
    where private.venue_feature_enabled(
            v_venue,
            'MENU_PROMOTIONS'
          )
      and p.active
      and p.start_at<=p_at
      and (p.end_at is null or p_at<p.end_at)
      and (p.venue_id is null or p.venue_id=v_venue)
      and (p.menu_id is null or p.menu_id=p_menu)
      and (
        p.target_category_id is null
        or exists(
          select 1
          from public.menu_categories mc
          where mc.menu_id=p_menu
            and mc.category_id=p.target_category_id
        )
      )
      and (
        p.target_dish_id is null
        or exists(
          select 1
          from public.menu_dishes md
          where md.menu_id=p_menu
            and md.dish_id=p.target_dish_id
        )
      )
      and (
        p.target_menu_id is null
        or private.menu_available_at(
          p.target_menu_id,
          v_venue,
          p_at
        )
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
    'categories',coalesce(
      (select categories from categories_payload),
      '[]'::jsonb
    ),
    'promotions',coalesce(
      (select promotions from promotions_payload),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end
$$;
