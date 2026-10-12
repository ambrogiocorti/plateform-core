
create or replace function public.get_dish_admin_detail(p_dish uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_dish public.dishes;
begin
  v_actor:=private.authorize(null,array['ADMIN']::public.user_role[],false);

  select * into v_dish
  from public.dishes
  where id=p_dish;

  if v_dish.id is null then raise exception 'NOT_FOUND'; end if;

  return jsonb_build_object(
    'viewer_user_id',v_actor,
    'can_manage_shared_catalog',private.can_manage_shared_catalog(),
    'dish',jsonb_build_object(
      'id',v_dish.id,
      'name',v_dish.name,
      'beverage',v_dish.beverage,
      'version',v_dish.version
    ),
    'ingredients_catalog',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',i.id,
          'name',i.name,
          'active',i.active,
          'allergen_ids',coalesce((
            select jsonb_agg(ia.allergen_id order by ia.allergen_id)
            from public.ingredient_allergens ia
            where ia.ingredient_id=i.id
          ),'[]'::jsonb)
        )
        order by i.name,i.id
      )
      from public.ingredients i
    ),'[]'::jsonb),
    'allergens',coalesce((
      select jsonb_agg(
        jsonb_build_object('id',a.id,'code',a.code,'name',a.name)
        order by a.name,a.id
      )
      from public.allergens a
    ),'[]'::jsonb),
    'dietary_tags',coalesce((
      select jsonb_agg(
        jsonb_build_object('id',t.id,'code',t.code,'label',t.label)
        order by t.label,t.id
      )
      from public.dietary_tags t
    ),'[]'::jsonb),
    'ingredients',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'ingredient_id',di.ingredient_id,
          'name',i.name,
          'removable',di.removable,
          'quantity',di.quantity,
          'unit',di.unit,
          'yield_factor',di.yield_factor,
          'waste_percentage',di.waste_percentage,
          'allergen_ids',coalesce((
            select jsonb_agg(ia.allergen_id order by ia.allergen_id)
            from public.ingredient_allergens ia
            where ia.ingredient_id=di.ingredient_id
          ),'[]'::jsonb)
        )
        order by i.name,i.id
      )
      from public.dish_ingredients di
      join public.ingredients i on i.id=di.ingredient_id
      where di.dish_id=p_dish
    ),'[]'::jsonb),
    'tag_ids',coalesce((
      select jsonb_agg(dt.tag_id order by dt.tag_id)
      from public.dish_dietary_tags dt
      where dt.dish_id=p_dish
    ),'[]'::jsonb),
    'variants',coalesce((
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
            where o.group_id=g.id
              and o.active
          ),'[]'::jsonb)
        )
        order by g.name,g.id
      )
      from public.variant_groups g
      where g.dish_id=p_dish
        and g.active
    ),'[]'::jsonb)
  );
end
$$;

revoke all on function public.get_dish_admin_detail(uuid)
from public,anon;
grant execute on function public.get_dish_admin_detail(uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_dish_admin_detail(uuid)','authenticated')
on conflict do nothing;
