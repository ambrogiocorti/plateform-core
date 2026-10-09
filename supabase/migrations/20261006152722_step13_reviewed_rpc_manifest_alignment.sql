
insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_billing_workspace(p_account uuid)','authenticated'),
  ('public.get_operational_statistics(p_venue uuid, p_start date, p_end date)','authenticated')
on conflict do nothing;
