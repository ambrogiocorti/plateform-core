
revoke execute on function public.record_navigation_telemetry(
  text,text,text,uuid,text,text,uuid
) from anon, public;

grant execute on function public.record_navigation_telemetry(
  text,text,text,uuid,text,text,uuid
) to authenticated, service_role;

delete from private.api_permission_manifest
where api_role='anon'
  and function_identity='public.record_navigation_telemetry(text,text,text,uuid,text,text,uuid)';
