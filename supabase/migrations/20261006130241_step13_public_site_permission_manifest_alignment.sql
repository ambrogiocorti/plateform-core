
insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_booking_configuration(p_venue uuid)','anon'),
  ('public.get_booking_configuration(p_venue uuid)','authenticated'),
  ('public.get_public_menu(p_venue uuid)','anon'),
  ('public.get_public_menu(p_venue uuid)','authenticated')
on conflict do nothing;
