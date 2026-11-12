-- Read-only, privileged readiness signal for native GoTrue audit events.
-- Action names alone do not prove authentication success or failure.
CREATE OR REPLACE FUNCTION public.get_auth_audit_readiness()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 RETURN (
 SELECT jsonb_build_object(
  'status',CASE WHEN count(*)=0 THEN 'DATABASE_SINK_NOT_VERIFIED'
    ELSE 'NATIVE_EVENTS_PRESENT_OUTCOMES_UNCLASSIFIED' END,
  'native_rows',count(*),
  'login_attempts',count(*) FILTER(WHERE payload->>'action'='login'),
  'mfa_verification_attempts',count(*) FILTER(WHERE payload->>'action'='verification_attempted'),
  'latest_event_at',max(created_at),
  'login_failures_certified',false,
  'mfa_failures_certified',false
 )
 FROM auth.audit_log_entries
 );
END $fn$;
REVOKE ALL ON FUNCTION public.get_auth_audit_readiness() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_auth_audit_readiness() TO authenticated;
