
create or replace function public.get_claimable_print_jobs(
  p_venue uuid,
  p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_role public.user_role;
begin
  perform private.authorize(
    p_venue,
    array['ADMIN','CASHIER','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );
  if p_limit is null or p_limit not between 1 and 20 then raise exception 'INVALID_LIMIT'; end if;
  v_role:=private.current_role();
  return coalesce((
    select jsonb_agg(
      jsonb_build_object('id',j.id,'driver',d.driver)
      order by j.created_at,j.id
    )
    from (
      select j.id,j.print_device_id,j.created_at
      from public.print_jobs j
      join public.print_devices d0 on d0.id=j.print_device_id
      where j.venue_id=p_venue
        and j.status='QUEUED'
        and d0.active
        and d0.driver in ('EPOS','BRIDGE')
        and v_role=any(d0.allowed_roles)
      order by j.created_at,j.id
      limit p_limit
    ) j
    join public.print_devices d on d.id=j.print_device_id
  ),'[]'::jsonb);
end
$$;

revoke all on function public.get_claimable_print_jobs(uuid,integer) from public,anon;
grant execute on function public.get_claimable_print_jobs(uuid,integer) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_claimable_print_jobs(uuid,integer)','authenticated')
on conflict do nothing;
