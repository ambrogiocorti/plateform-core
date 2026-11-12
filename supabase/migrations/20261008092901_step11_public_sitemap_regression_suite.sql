
create or replace function private.test_step11_public_sitemap_contract()
returns jsonb language plpgsql security invoker set search_path=''
as $function$
declare
  v_map jsonb := public.get_public_sitemap_entries();
  v_home jsonb := public.get_public_page_metadata('/');
  v_count integer;
  v_rows integer;
begin
  v_count := jsonb_array_length(v_map->'urls');
  select count(*)::integer into v_rows
  from jsonb_array_elements(v_map->'urls') j
  where j->>'path' like '/staff%'
     or j->>'path' like '/tavolo/%'
     or j->>'loc' !~ '^https://'
     or j->>'path' not like '/%';
  if v_rows <> 0 then raise exception 'STEP11_SITEMAP_EXPOSES_FORBIDDEN_URL'; end if;

  if (v_home->>'robots'='index,follow') is distinct from
     (v_map->>'indexable')::boolean
  then raise exception 'STEP11_SITEMAP_INDEXING_MISMATCH'; end if;
  if (v_map->>'indexable')::boolean and v_count=0 then
    raise exception 'STEP11_INDEXABLE_SITEMAP_EMPTY';
  end if;
  if not (v_map->>'indexable')::boolean and v_count<>0 then
    raise exception 'STEP11_NOINDEX_SITEMAP_NOT_EMPTY';
  end if;

  return jsonb_build_object(
    'public_urls',v_count,
    'no_private_routes',true,
    'no_test_domain_urls',not (v_map->>'indexable')::boolean,
    'consistent_with_page_metadata',true
  );
end
$function$;
revoke all on function private.test_step11_public_sitemap_contract() from public,anon,authenticated;
grant execute on function private.test_step11_public_sitemap_contract() to service_role;
