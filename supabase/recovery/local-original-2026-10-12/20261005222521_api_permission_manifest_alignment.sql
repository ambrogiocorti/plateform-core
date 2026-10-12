insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.abort_restore_cutover(uuid,uuid,text,uuid)','authenticated'),
  ('public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid)','authenticated'),
  ('public.confirm_restore_cutover(uuid,uuid,text,text,uuid)','authenticated'),
  ('public.get_admin_operational_overview(uuid)','authenticated'),
  ('public.get_kitchen_admin_overview(uuid)','authenticated'),
  ('private.abort_restore_cutover_impl(uuid,uuid,text,uuid)','authenticated'),
  ('private.configure_continuity_targets_impl(bigint,integer,integer,integer,integer,uuid)','authenticated'),
  ('private.confirm_restore_cutover_impl(uuid,uuid,text,text,uuid)','authenticated')
on conflict(function_identity,api_role) do nothing;
