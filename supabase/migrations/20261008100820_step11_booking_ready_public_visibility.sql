
create or replace function private.public_booking_ready(p_venue uuid)
returns boolean language sql stable security definer set search_path=''
as $fn$
 select private.installation_active() and exists (
   select 1
   from public.venues v
   join public.venue_settings vs on vs.venue_id=v.id
   join public.services s on s.venue_id=v.id and s.active
   join public.service_booking_rules r on r.venue_id=v.id and r.service_id=s.id
   where v.id=p_venue
     and v.active and v.operational_status='OPEN'
     and vs.reservations_enabled
     and array_length(s.weekdays,1)>0
     and r.slot_interval_minutes>0
 );
$fn$;
revoke all on function private.public_booking_ready(uuid) from public,anon,authenticated;

do $upgrade$
declare
  v_source text;
  v_old text;
  v_new text;
begin
  v_source:=pg_get_functiondef('public.get_public_site()'::regprocedure);
  v_old:=$old$'reservations_enabled',s.reservations_enabled and p.status='ACTIVE' and v.operational_status='OPEN'$old$;
  v_new:=$new$'reservations_enabled',private.public_booking_ready(v.id)$new$;
  if position(v_old in v_source)=0 then raise exception 'STEP11_SITE_FUNCTION_SIGNATURE_CHANGED'; end if;
  execute replace(v_source,v_old,v_new);

  v_source:=pg_get_functiondef('public.get_public_navigation(uuid)'::regprocedure);
  v_old:=$old$select exists (
    select 1 from public.venues v
    join public.venue_settings s on s.venue_id=v.id
    where v.active
      and v.operational_status='OPEN'
      and s.reservations_enabled
      and (v_venue is null or v.id=v_venue)
  ) into v_bookable;$old$;
  v_new:=$new$select exists (
    select 1 from public.venues v
    where v.active and (v_venue is null or v.id=v_venue)
      and private.public_booking_ready(v.id)
  ) into v_bookable;$new$;
  if position(v_old in v_source)=0 then raise exception 'STEP11_NAV_FUNCTION_SIGNATURE_CHANGED'; end if;
  execute replace(v_source,v_old,v_new);

  v_source:=pg_get_functiondef('public.get_public_page_metadata(text,uuid)'::regprocedure);
  v_old:=$old$select exists (
      select 1 from public.venues v
      join public.venue_settings s on s.venue_id=v.id
      where v.active and v.operational_status='OPEN'
        and s.reservations_enabled
        and (v_venue is null or v.id=v_venue)
    ) into v_bookable;$old$;
  v_new:=$new$select exists (
      select 1 from public.venues v
      where v.active and (v_venue is null or v.id=v_venue)
        and private.public_booking_ready(v.id)
    ) into v_bookable;$new$;
  if position(v_old in v_source)=0 then raise exception 'STEP11_METADATA_FUNCTION_SIGNATURE_CHANGED'; end if;
  execute replace(v_source,v_old,v_new);
end
$upgrade$;
