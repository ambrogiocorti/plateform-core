
create or replace function public.record_navigation_telemetry(
  p_event text,
  p_surface text,
  p_route text,
  p_venue uuid,
  p_environment text,
  p_release text,
  p_request uuid
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_event text:=upper(trim(p_event));
  v_surface text:=upper(trim(p_surface));
  v_route text:=trim(p_route);
begin
  if v_event not in ('PAGE_VIEW','ROUTE_CHANGE')
     or v_surface not in (
       'PUBLIC_MENU','CUSTOMER','WAITER','HOST','KITCHEN',
       'PASS','CASHIER','ADMIN','SUPER_ADMIN'
     )
     or v_route is null
     or length(v_route) not between 1 and 200
     or v_route !~ '^/[A-Za-z0-9/_-]*$'
     or p_environment not in ('development','staging','production')
     or p_release is null
     or length(p_release) not between 1 and 50
     or p_release !~ '^[A-Za-z0-9._-]+$'
     or p_request is null
  then
    raise exception 'INVALID_NAVIGATION_TELEMETRY';
  end if;

  if p_venue is not null
     and not exists(
       select 1 from public.venues v
       where v.id=p_venue and v.active
     )
  then
    raise exception 'VENUE_NOT_FOUND';
  end if;

  insert into public.telemetry_events(
    venue_id,event,environment,release_version,
    request_id,correlation_id,properties
  )
  values(
    p_venue,
    v_event,
    p_environment,
    p_release,
    p_request,
    private.request_correlation_id(p_request),
    jsonb_build_object(
      'surface',v_surface,
      'route',v_route
    )
  );
end
$$;

revoke all on function public.record_navigation_telemetry(
  text,text,text,uuid,text,text,uuid
) from public;

grant execute on function public.record_navigation_telemetry(
  text,text,text,uuid,text,text,uuid
) to anon,authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values
  ('public.record_navigation_telemetry(text,text,text,uuid,text,text,uuid)','anon'),
  ('public.record_navigation_telemetry(text,text,text,uuid,text,text,uuid)','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(
  key,category,required,description
)
values(
  'NAVIGATION_TELEMETRY_SEPARATION',
  'REGRESSION',
  true,
  'Pure page/route navigation is recorded in telemetry without creating a security audit event.'
)
on conflict(key) do nothing;
