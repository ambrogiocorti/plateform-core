
create or replace function public.get_public_sitemap_entries()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
revoke all on function public.get_public_sitemap_entries() from public,anon,authenticated;
grant execute on function public.get_public_sitemap_entries() to anon,authenticated,service_role;
comment on function public.get_public_sitemap_entries() is
'Step 11 read-only list of indexable canonical URLs for the public sitemap renderer. Omits test origins, staff routes, QR sessions, unpublished content and multi-venue menu URLs lacking an approved canonical scheme.';
