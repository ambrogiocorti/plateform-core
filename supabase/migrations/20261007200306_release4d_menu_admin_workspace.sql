
create or replace function public.get_menu_admin_workspace(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid;
begin
  if p_venue is null then raise exception 'VENUE_REQUIRED'; end if;
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[],false);

  return jsonb_build_object(
    'viewer_user_id',v_actor,
    'can_manage_shared_catalog',private.can_manage_shared_catalog(),
    'categories',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',c.id,
          'name',c.name,
          'description',c.description,
          'sort_order',c.sort_order,
          'active',c.active,
          'version',c.version
        )
        order by c.sort_order,c.name,c.id
      )
      from public.categories c
    ),'[]'::jsonb),
    'stations',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',s.id,
          'name',s.name,
          'active',s.active,
          'version',s.version
        )
        order by s.name,s.id
      )
      from public.stations s
      where s.venue_id=p_venue
    ),'[]'::jsonb),
    'dishes',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',d.id,
          'category_id',d.category_id,
          'category_name',c.name,
          'name',d.name,
          'description',d.description,
          'image_path',d.image_path,
          'beverage',d.beverage,
          'price_cents',d.price_cents,
          'active',d.active,
          'sort_order',d.sort_order,
          'schedule_mode',d.schedule_mode,
          'available_from',d.available_from,
          'available_until',d.available_until,
          'weekdays',to_jsonb(d.weekdays),
          'version',d.version,
          'venue_setting',
            case when vds.dish_id is null then null else jsonb_build_object(
              'enabled',vds.enabled,
              'local_price_cents',vds.local_price_cents,
              'availability',vds.availability,
              'availability_date',vds.availability_date,
              'version',vds.version,
              'primary_station_id',vds.local_station_id,
              'observer_station_ids',coalesce((
                select jsonb_agg(a.station_id order by a.station_id)
                from public.dish_station_assignments a
                where a.venue_id=p_venue
                  and a.dish_id=d.id
                  and not a.is_primary
              ),'[]'::jsonb)
            ) end
        )
        order by c.sort_order,d.sort_order,d.name,d.id
      )
      from public.dishes d
      join public.categories c on c.id=d.category_id
      left join public.venue_dish_settings vds
        on vds.venue_id=p_venue
       and vds.dish_id=d.id
    ),'[]'::jsonb)
  );
end
$$;

revoke all on function public.get_menu_admin_workspace(uuid)
from public,anon;
grant execute on function public.get_menu_admin_workspace(uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_menu_admin_workspace(uuid)','authenticated')
on conflict do nothing;
