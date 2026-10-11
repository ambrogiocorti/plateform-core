-- RECOVERY FIXTURE ONLY, not an applied migration. Host Development already has
-- these RPCs, but none of the currently tracked local migrations creates them.
-- Extracted verbatim from pg_get_functiondef on 2026-10-11.
-- This restores PGlite's representative schema for test diagnostics only;
-- complete clean-install SQL provenance is still NOT VERIFIED.
-- Source: public.get_public_menu_index(uuid)
CREATE OR REPLACE FUNCTION public.get_public_menu_index(p_venue uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
REVOKE ALL ON FUNCTION public.get_public_menu_index(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_menu_index(uuid) TO anon,authenticated,service_role;

-- Source: public.get_public_navigation(uuid)
CREATE OR REPLACE FUNCTION public.get_public_navigation(p_venue uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where v.active and (v_venue is null or v.id=v_venue)
      and private.public_booking_ready(v.id)
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
REVOKE ALL ON FUNCTION public.get_public_navigation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_navigation(uuid) TO anon,authenticated,service_role;

-- Source: public.get_public_page_metadata(text,uuid)
CREATE OR REPLACE FUNCTION public.get_public_page_metadata(p_path text DEFAULT '/'::text, p_venue uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile public.restaurant_profile;
  v_count integer;
  v_first uuid;
  v_venue uuid;
  v_multi boolean := false;
  v_path text := coalesce(p_path, '');
  v_name text;
  v_prefix text;
  v_description text;
  v_origin text;
  v_canonical text;
  v_image text;
  v_indexable boolean;
  v_venue_name text;
  v_venue_slug text;
  v_slug text;
  v_menu_id uuid;
  v_menu_name text;
  v_bookable boolean := false;
begin
  -- The only recognized routes are public, and no input is treated as HTML.
  if length(v_path) > 160
     or v_path !~ '^/(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*)?$'
  then raise exception 'PAGE_NOT_FOUND'; end if;

  select * into v_profile from public.restaurant_profile where id;
  if not found then raise exception 'PAGE_NOT_FOUND'; end if;
  v_name := v_profile.name;

  select coalesce(licensed,false) into v_multi
  from public.feature_flags where name = 'MULTI_VENUE';
  v_multi := coalesce(v_multi,false);

  select count(*)::integer, (array_agg(id order by id))[1]
    into v_count,v_first
  from public.venues where active;

  if not v_multi and v_count>1 then raise exception 'INVALID_INSTALLATION_STATE'; end if;
  if p_venue is not null then
    select id into v_venue from public.venues where id=p_venue and active;
    if v_venue is null then raise exception 'PAGE_NOT_FOUND'; end if;
  elsif v_count=1 then
    v_venue := v_first;
  end if;

  if v_path='/' then
    v_prefix := null;
  elsif v_path='/menu' then
    v_prefix := 'Menu';
  elsif v_path='/ristorante' then
    v_prefix := 'Il ristorante';
  elsif v_path='/gallery' then
    v_prefix := 'Gallery';
  elsif v_path='/contatti' then
    v_prefix := 'Contatti';
  elsif v_path='/prenota' then
    select exists (
      select 1 from public.venues v
      where v.active and (v_venue is null or v.id=v_venue)
        and private.public_booking_ready(v.id)
    ) into v_bookable;
    if not v_bookable or v_profile.status<>'ACTIVE' then
      raise exception 'PAGE_NOT_FOUND';
    end if;
    v_prefix := 'Prenota';
  elsif v_path='/sedi' then
    if not v_multi or v_count<2 then raise exception 'PAGE_NOT_FOUND'; end if;
    v_prefix := 'Le nostre sedi';
  elsif v_path like '/sedi/%' then
    if not v_multi or v_count<2 then raise exception 'PAGE_NOT_FOUND'; end if;
    v_slug:=substring(v_path from 7);
    select name,slug into v_venue_name,v_venue_slug
    from public.venues where active and slug=v_slug;
    if v_venue_name is null then raise exception 'PAGE_NOT_FOUND'; end if;
    if v_venue is not null and v_venue_slug is distinct from
       (select slug from public.venues where id=v_venue)
    then raise exception 'PAGE_NOT_FOUND'; end if;
    v_prefix := v_venue_name;
  elsif v_path like '/menu/%' then
    v_slug:=substring(v_path from 7);
    select id,name into v_menu_id,v_menu_name
    from public.menus where slug=v_slug and active and published;
    if v_menu_id is null then raise exception 'PAGE_NOT_FOUND'; end if;
    if v_venue is null then raise exception 'VENUE_REQUIRED'; end if;
    if not private.menu_available_at(v_menu_id,v_venue,clock_timestamp()) then
      raise exception 'PAGE_NOT_FOUND';
    end if;
    v_prefix := v_menu_name;
  else
    raise exception 'PAGE_NOT_FOUND';
  end if;

  v_description := nullif(trim(coalesce(v_profile.public_content->>'seo_description','')),'');
  if v_description is null then
    v_description := nullif(trim(coalesce(v_profile.public_content->>'hero_subtitle','')),'');
  end if;
  v_description := left(coalesce(v_description,v_name),200);

  v_origin := rtrim(trim(coalesce(v_profile.public_base_url,'')),'/');
  v_indexable :=
    v_origin ~* '^https://[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$'
    and v_origin !~* '(^https://localhost|[.]example$|[.]test$)';
  -- A multi-venue menu needs a deployed, unique venue-aware canonical path.
  if v_path like '/menu/%' and v_multi and v_count>1 then
    v_indexable := false;
  end if;
  v_canonical := case when v_indexable then v_origin||v_path else null end;

  v_image := nullif(trim(coalesce(v_profile.public_content->>'hero_image_url','')),'');
  if v_image is null then
    v_image := nullif(trim(coalesce(v_profile.branding->>'logo_url','')),'');
  end if;
  if v_image is not null and v_image !~* '^https://' then v_image := null; end if;

  return jsonb_build_object(
    'path',v_path,
    'title',case when v_prefix is null
      then coalesce(nullif(trim(v_profile.public_content->>'seo_title'),''),v_name)
      else v_prefix||' | '||v_name end,
    'description',v_description,
    'canonical_url',v_canonical,
    'robots',case when v_indexable then 'index,follow' else 'noindex,nofollow' end,
    'og_type','website',
    'og_image_url',v_image,
    'site_name',v_name
  );
end
$function$;
REVOKE ALL ON FUNCTION public.get_public_page_metadata(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_page_metadata(text,uuid) TO anon,authenticated,service_role;

-- Source: public.get_public_sitemap_entries()
CREATE OR REPLACE FUNCTION public.get_public_sitemap_entries()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_home jsonb;
  v_nav jsonb;
  v_path text;
  v_page jsonb;
  v_urls jsonb := '[]'::jsonb;
  v_multi boolean;
begin
  v_home := public.get_public_page_metadata('/');
  -- No public sitemap entries for a development, reserved or unverified origin.
  if v_home->>'robots' <> 'index,follow' then
    return jsonb_build_object('indexable',false,'urls','[]'::jsonb);
  end if;

  v_nav := public.get_public_navigation();
  v_multi := coalesce((v_nav->>'multi_venue')::boolean,false);

  for v_path in
    select distinct path
    from (
      select j.value->>'path' as path
      from jsonb_array_elements(v_nav->'items') j
      union all
      select v.value->>'path'
      from jsonb_array_elements(v_nav->'venues') v
      where v_multi
      union all
      select '/menu/'||(m.value->>'slug')
      from jsonb_array_elements(v_nav->'menus') m
      where not v_multi
    ) possible_urls
    where path is not null
    order by path
  loop
    v_page := public.get_public_page_metadata(v_path);
    if v_page->>'robots' = 'index,follow'
      and v_page->>'canonical_url' is not null
    then
      v_urls := v_urls || jsonb_build_array(
        jsonb_build_object(
          'path',v_path,
          'loc',v_page->>'canonical_url'
        )
      );
    end if;
  end loop;

  return jsonb_build_object('indexable',true,'urls',v_urls);
end
$function$;
REVOKE ALL ON FUNCTION public.get_public_sitemap_entries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_sitemap_entries() TO anon,authenticated,service_role;
