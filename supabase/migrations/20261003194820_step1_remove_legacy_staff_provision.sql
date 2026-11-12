begin;
revoke all on function public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid)
  from public,anon,authenticated,service_role;
drop function public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid);
delete from private.api_permission_manifest
where function_identity in (
  'public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid)',
  'public.complete_staff_login(text,text,text)'
);
notify pgrst,'reload schema';
commit;