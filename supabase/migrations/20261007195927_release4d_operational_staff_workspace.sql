
create or replace function public.get_operational_staff_workspace(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_target public.staff_profiles;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[],false);

  select * into v_target
  from public.staff_profiles
  where id=p_user;

  if v_target.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if not private.can_manage_staff(p_user) then
    raise exception 'STAFF_MANAGEMENT_FORBIDDEN' using errcode='42501';
  end if;

  if v_target.role='KITCHEN_STAFF' then
    return jsonb_build_object(
      'kind','STATION',
      'resources',coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',s.id,
            'venue_id',s.venue_id,
            'name',s.name,
            'active',s.active,
            'assigned',exists(
              select 1
              from public.station_staff_assignments a
              where a.station_id=s.id
                and a.user_id=p_user
                and a.active
            )
          )
          order by v.name,s.name,s.id
        )
        from public.stations s
        join public.venues v on v.id=s.venue_id
        where s.active
          and private.has_venue(s.venue_id)
          and private.staff_has_venue(p_user,s.venue_id)
      ),'[]'::jsonb)
    );
  elsif v_target.role='CASHIER' then
    return jsonb_build_object(
      'kind','REGISTER',
      'resources',coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id',r.id,
            'venue_id',r.venue_id,
            'name',r.name,
            'active',r.active,
            'assigned',exists(
              select 1
              from public.cashier_assignments a
              where a.cash_register_id=r.id
                and a.user_id=p_user
                and a.active
            )
          )
          order by v.name,r.name,r.id
        )
        from public.cash_registers r
        join public.venues v on v.id=r.venue_id
        where r.active
          and private.has_venue(r.venue_id)
          and private.staff_has_venue(p_user,r.venue_id)
      ),'[]'::jsonb)
    );
  end if;

  return jsonb_build_object('kind',null,'resources','[]'::jsonb);
end
$$;

revoke all on function public.get_operational_staff_workspace(uuid)
from public,anon;
grant execute on function public.get_operational_staff_workspace(uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_operational_staff_workspace(uuid)','authenticated')
on conflict do nothing;
