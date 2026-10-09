
create or replace function public.get_cash_workspace(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_actor uuid;
begin
  if p_venue is null then
    raise exception 'VENUE_REQUIRED';
  end if;

  v_actor:=private.authorize(
    p_venue,
    array['ADMIN','CASHIER']::public.user_role[],
    false
  );

  return jsonb_build_object(
    'viewer_user_id',v_actor,
    'registers',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',r.id,
          'venue_id',r.venue_id,
          'name',r.name,
          'code',r.code,
          'location',r.location,
          'status',r.status,
          'version',r.version,
          'payment_methods',to_jsonb(r.payment_methods),
          'open_session',
            case when crs.id is null then null else
              jsonb_build_object(
                'register_session_id',crs.id,
                'service_session_id',ss.id,
                'service_id',ss.service_id,
                'service_name',svc.name,
                'service_status',ss.status,
                'opening_float_cents',crs.opening_float_cents,
                'opened_at',crs.opened_at
              )
            end
        )
        order by r.name,r.id
      )
      from public.cash_registers r
      left join public.cash_register_sessions crs
        on crs.cash_register_id=r.id
       and crs.closed_at is null
      left join public.service_sessions ss
        on ss.id=crs.service_session_id
      left join public.services svc
        on svc.id=ss.service_id
      where r.venue_id=p_venue
        and r.active
        and private.can_use_register(r.id)
    ),'[]'::jsonb)
  );
end
$$;

revoke all on function public.get_cash_workspace(uuid)
from public,anon;
grant execute on function public.get_cash_workspace(uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_cash_workspace(uuid)','authenticated')
on conflict do nothing;
