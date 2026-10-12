
create or replace function private.test_step11_public_metadata_contract()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_meta jsonb;
  v_nav jsonb;
  v_route text;
  v_denied integer := 0;
  v_bad text;
begin
  v_meta := public.get_public_page_metadata('/');
  if v_meta->>'path' <> '/'
     or coalesce(v_meta->>'title','') = ''
     or v_meta->>'og_type' <> 'website'
     or v_meta->>'robots' not in ('index,follow','noindex,nofollow')
  then raise exception 'STEP11_INVALID_HOME_METADATA'; end if;

  v_nav := public.get_public_navigation();
  if exists (
     select 1 from jsonb_array_elements(v_nav->'items') v
     where v->>'path' like '/staff%'
  ) then raise exception 'STEP11_STAFF_LINK_EXPOSED'; end if;

  if not has_function_privilege('anon','public.get_public_page_metadata(text,uuid)','EXECUTE')
     or has_table_privilege('anon','public.menus','SELECT')
     or has_table_privilege('anon','public.feature_flags','SELECT')
  then raise exception 'STEP11_PUBLIC_PRIVILEGE_REGRESSION'; end if;

  if (public.get_public_page_metadata('/menu')->>'path') <> '/menu'
    or (public.get_public_page_metadata('/ristorante')->>'path') <> '/ristorante'
    or (public.get_public_page_metadata('/contatti')->>'path') <> '/contatti'
    or (public.get_public_page_metadata('/gallery')->>'path') <> '/gallery'
  then raise exception 'STEP11_BASE_ROUTES_REGRESSION'; end if;

  foreach v_route in array array[
    '/staff','/staff/login','/tavolo/fake-account','/admin','/api/secret',
    '/_private','//staff','/%2e%2e/staff','/menu/nonexistent-step11'
  ]
  loop
    begin
      perform public.get_public_page_metadata(v_route);
      raise exception 'STEP11_EXPECTED_ROUTE_DENIAL: %',v_route;
    exception when raise_exception then
      get stacked diagnostics v_bad = message_text;
      if v_bad <> 'PAGE_NOT_FOUND' then raise; end if;
      v_denied := v_denied + 1;
    end;
  end loop;

  begin
    perform public.get_public_page_metadata('/', '00000000-0000-0000-0000-000000000001'::uuid);
    raise exception 'STEP11_EXPECTED_VENUE_DENIAL';
  exception when raise_exception then
    get stacked diagnostics v_bad = message_text;
    if v_bad <> 'PAGE_NOT_FOUND' then raise; end if;
    v_denied := v_denied+1;
  end;

  if v_meta->>'robots' = 'noindex,nofollow' and v_meta->>'canonical_url' is not null
  then raise exception 'STEP11_NOINDEX_CANONICAL_LEAK'; end if;

  return jsonb_build_object(
    'home_metadata',true,
    'static_routes',true,
    'anonymous_permissions',true,
    'no_staff_navigation',true,
    'rejected_unauthorized_routes',v_denied,
    'noindex_has_no_canonical',true
  );
end
$function$;
revoke all on function private.test_step11_public_metadata_contract() from public,anon,authenticated;
grant execute on function private.test_step11_public_metadata_contract() to service_role;
comment on function private.test_step11_public_metadata_contract() is
'Repeatable read-only test for Step 11 public routes, anonymous privilege model and noindex metadata.';
