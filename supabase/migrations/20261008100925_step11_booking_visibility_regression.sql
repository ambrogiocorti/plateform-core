
create or replace function private.test_step11_booking_visibility_contract()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_row record;
  v_ready boolean;
  v_nav jsonb;
  v_site jsonb := public.get_public_site();
  v_site_venue jsonb;
  v_page jsonb;
  v_count integer := 0;
  v_error text;
begin
  for v_row in select id from public.venues where active order by id loop
    v_ready := private.public_booking_ready(v_row.id);
    v_nav := public.get_public_navigation(v_row.id);
    select x.value into v_site_venue
    from jsonb_array_elements(v_site->'venues') x
    where x.value->>'id' = v_row.id::text;
    if v_site_venue is null
      or coalesce((v_nav->>'reservations_enabled')::boolean,false) <> v_ready
      or coalesce((v_site_venue->>'reservations_enabled')::boolean,false) <> v_ready
    then raise exception 'STEP11_BOOKING_VISIBILITY_MISMATCH'; end if;

    if v_ready then
      v_page := public.get_public_page_metadata('/prenota',v_row.id);
      if v_page->>'path' <> '/prenota' then
        raise exception 'STEP11_BOOKING_PAGE_UNEXPECTED';
      end if;
    else
      begin
        perform public.get_public_page_metadata('/prenota',v_row.id);
        raise exception 'STEP11_BOOKING_PAGE_SHOULD_BE_HIDDEN';
      exception when raise_exception then
        get stacked diagnostics v_error=message_text;
        if v_error <> 'PAGE_NOT_FOUND' then raise; end if;
      end;
    end if;
    v_count := v_count+1;
  end loop;
  return jsonb_build_object('active_venues_checked',v_count,'navigation_matches_readiness',true,
    'site_matches_readiness',true,'booking_page_matches_readiness',true);
end
$fn$;
revoke all on function private.test_step11_booking_visibility_contract() from public,anon,authenticated;
grant execute on function private.test_step11_booking_visibility_contract() to service_role;
