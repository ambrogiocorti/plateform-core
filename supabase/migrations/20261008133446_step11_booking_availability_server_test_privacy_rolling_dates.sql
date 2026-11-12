do $patch$
declare
  src text;
  insertion text;
begin
  src := pg_get_functiondef('private.test_public_booking_availability_server_authority()'::regprocedure);
  if position('date ''2026-10-10''' in src)=0
     or position('date ''2026-10-11''' in src)=0
     or position('  v_detail text;' in src)=0
     or position(E'  begin\n    update public.venue_settings' in src)=0
  then raise exception 'STEP11_TEST_DEFINITION_CHANGED'; end if;

  src := replace(src, '  v_detail text;', E'  v_detail text;\n  v_test_date date;\n  v_deposit_date date;');
  insertion := E'  v_test_date := (now() at time zone (select timezone from public.venues where id=v_venue))::date + 2;\n'
           || E'  v_deposit_date := v_test_date + 1;\n'
           || E'  begin\n'
           || E'    update public.restaurant_profile\n'
           || E'    set public_content=jsonb_set(coalesce(public_content,''{}''::jsonb),\n'
           || E'      ''{privacy_url}'',''"https://plateform-test.example/privacy"''::jsonb,true)\n'
           || E'    where id;\n'
           || E'    update public.venue_settings';
  src := replace(src,E'  begin\n    update public.venue_settings',insertion);
  src := replace(src,'date ''2026-10-10''','v_test_date');
  src := replace(src,'date ''2026-10-11''','v_deposit_date');
  execute src;
end
$patch$;