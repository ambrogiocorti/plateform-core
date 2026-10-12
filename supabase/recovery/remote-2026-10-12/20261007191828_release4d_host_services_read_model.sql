
create or replace function public.get_host_services(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[],false);
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id',s.id,
        'name',s.name,
        'starts_at',s.starts_at,
        'ends_at',s.ends_at
      )
      order by s.starts_at,s.name,s.id
    )
    from public.services s
    where s.venue_id=p_venue
      and s.active
  ),'[]'::jsonb);
end
$$;

revoke all on function public.get_host_services(uuid) from public,anon;
grant execute on function public.get_host_services(uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_host_services(uuid)','authenticated')
on conflict do nothing;
