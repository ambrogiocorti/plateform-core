
create or replace function public.get_public_page_metadata(
  p_path text default '/',
  p_venue uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
      join public.venue_settings s on s.venue_id=v.id
      where v.active and v.operational_status='OPEN'
        and s.reservations_enabled
        and (v_venue is null or v.id=v_venue)
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

revoke all on function public.get_public_page_metadata(text,uuid) from public,anon,authenticated;
grant execute on function public.get_public_page_metadata(text,uuid) to anon,authenticated,service_role;
comment on function public.get_public_page_metadata(text,uuid) is
  'Step 11 read-only metadata for strictly whitelisted public routes. Unverified/test hosts are noindex; staff and table QR routes are never valid SEO pages.';
