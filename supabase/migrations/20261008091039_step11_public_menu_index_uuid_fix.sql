create or replace function public.get_public_menu_index(p_venue uuid default null)
returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare v_venue uuid; v_count integer; v_now timestamptz:=clock_timestamp(); v_menus jsonb;
begin
  if p_venue is null then
    select count(*)::integer,(array_agg(v.id order by v.id))[1]
      into v_count,v_venue from public.venues v where v.active;
    if v_count=0 then return jsonb_build_object('venue_id',null,'menus','[]'::jsonb); end if;
    if v_count>1 then raise exception 'VENUE_REQUIRED'; end if;
  else
    select v.id into v_venue from public.venues v where v.id=p_venue and v.active;
    if v_venue is null then raise exception 'VENUE_NOT_FOUND'; end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.public_menu_id,'slug',m.slug,'name',m.name)
                 order by m.sort_order,m.name,m.id),'[]'::jsonb)
    into v_menus
  from public.menus m join public.menu_venues mv on mv.menu_id=m.id and mv.venue_id=v_venue
  where m.active and m.published and private.menu_available_at(m.id,v_venue,v_now);
  return jsonb_build_object('venue_id',v_venue,'menus',v_menus);
end $function$;
revoke all on function public.get_public_menu_index(uuid) from public,anon,authenticated;
grant execute on function public.get_public_menu_index(uuid) to anon,authenticated,service_role;