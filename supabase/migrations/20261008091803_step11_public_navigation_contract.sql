
create or replace function public.get_public_navigation(p_venue uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_profile public.restaurant_profile;
  v_multi boolean := false;
  v_count integer;
  v_first uuid;
  v_venue uuid;
  v_bookable boolean := false;
  v_nav jsonb;
  v_venues jsonb := '[]'::jsonb;
  v_menus jsonb := '[]'::jsonb;
begin
  select * into v_profile from public.restaurant_profile where id;
  if not found then raise exception 'INSTALLATION_NOT_CONFIGURED'; end if;

  select coalesce(licensed,false) into v_multi
  from public.feature_flags where name='MULTI_VENUE';
  v_multi := coalesce(v_multi,false);

  select count(*)::integer,(array_agg(id order by id))[1]
    into v_count,v_first from public.venues where active;

  if not v_multi and v_count>1 then
    raise exception 'INVALID_INSTALLATION_STATE';
  end if;

  if p_venue is not null then
    select id into v_venue from public.venues where id=p_venue and active;
    if v_venue is null then raise exception 'VENUE_NOT_FOUND'; end if;
  elsif v_count=1 then
    v_venue := v_first;
  end if;

  select exists (
    select 1 from public.venues v
    join public.venue_settings s on s.venue_id=v.id
    where v.active
      and v.operational_status='OPEN'
      and s.reservations_enabled
      and (v_venue is null or v.id=v_venue)
  ) into v_bookable;
  v_bookable := v_bookable and v_profile.status='ACTIVE';

  v_nav := jsonb_build_array(
    jsonb_build_object('label','Home','path','/'),
    jsonb_build_object('label','Menu','path','/menu'),
    jsonb_build_object('label','Il ristorante','path','/ristorante'),
    jsonb_build_object('label','Gallery','path','/gallery')
  );
  if v_multi and v_count>1 then
    v_nav:=v_nav||jsonb_build_array(jsonb_build_object('label','Sedi','path','/sedi'));
  end if;
  if v_bookable then
    v_nav:=v_nav||jsonb_build_array(jsonb_build_object('label','Prenota','path','/prenota'));
  end if;
  v_nav:=v_nav||jsonb_build_array(jsonb_build_object('label','Contatti','path','/contatti'));

  if v_multi then
    select coalesce(jsonb_agg(
      jsonb_build_object('name',v.name,'slug',v.slug,'path','/sedi/'||v.slug)
      order by v.name,v.id
    ),'[]'::jsonb)
    into v_venues
    from public.venues v where v.active;
  end if;

  if v_venue is not null then
    v_menus:=coalesce(public.get_public_menu_index(v_venue)->'menus','[]'::jsonb);
  end if;

  return jsonb_build_object(
    'site_name',v_profile.name,
    'multi_venue',v_multi and v_count>1,
    'selected_venue_id',v_venue,
    'reservations_enabled',v_bookable,
    'items',v_nav,
    'venues',v_venues,
    'menus',v_menus
  );
end
$function$;

revoke all on function public.get_public_navigation(uuid) from public,anon,authenticated;
grant execute on function public.get_public_navigation(uuid) to anon,authenticated,service_role;
comment on function public.get_public_navigation(uuid) is
'Step 11 public navigation contract: public-only routes and published menus. Staff pages and internal venue data are never returned.';