-- Only a trusted Edge service may attest real GoTrue-rejected credentials.
-- This RPC never accepts email, password, OTP, IP, user-agent or arbitrary payloads.
CREATE OR REPLACE FUNCTION public.record_auth_gateway_failure(
  p_action text, p_user uuid DEFAULT NULL, p_session uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE staff_role public.user_role;
BEGIN
  IF p_action NOT IN ('AUTH_LOGIN_FAILED','MFA_VERIFICATION_FAILED')
  THEN RAISE EXCEPTION 'INVALID_AUTH_FAILURE_ACTION'; END IF;

  IF p_action='AUTH_LOGIN_FAILED' THEN
    IF p_user IS NOT NULL OR p_session IS NOT NULL
    THEN RAISE EXCEPTION 'INVALID_ANONYMOUS_LOGIN_CONTEXT'; END IF;
  ELSE
    IF p_user IS NULL OR p_session IS NULL
    THEN RAISE EXCEPTION 'MFA_VERIFIED_SESSION_REQUIRED'; END IF;
    IF NOT EXISTS(
      SELECT 1 FROM auth.sessions s
      WHERE s.id=p_session AND s.user_id=p_user AND s.not_after IS NULL OR
        s.id=p_session AND s.user_id=p_user AND s.not_after>now()
    ) THEN RAISE EXCEPTION 'MFA_VERIFIED_SESSION_REQUIRED'; END IF;
    SELECT sp.role INTO staff_role FROM public.staff_profiles sp
    WHERE sp.id=p_user AND sp.active=true;
    IF staff_role IS NULL THEN RAISE EXCEPTION 'MFA_STAFF_IDENTITY_REQUIRED'; END IF;
  END IF;

  INSERT INTO public.audit_log(
   actor_type,actor_user_id,actor_role,action,resource_type,
   operation,result,session_id,old_values,new_values,
   request_id,correlation_id,emitter_source
  ) VALUES (
   CASE WHEN p_action='AUTH_LOGIN_FAILED' THEN 'SYSTEM' ELSE 'STAFF' END,
   p_user,
   CASE WHEN p_action='AUTH_LOGIN_FAILED' THEN 'SYSTEM'::public.user_role ELSE staff_role END,
   p_action,'authentication','VERIFY','DENIED',p_session,
   '{}'::jsonb,
   jsonb_build_object('source','GOTRUE_SERVER_VERIFIED','failure_class',
       CASE WHEN p_action='AUTH_LOGIN_FAILED' THEN 'INVALID_CREDENTIALS' ELSE 'MFA_CODE_REJECTED' END),
   gen_random_uuid(),gen_random_uuid(),'EDGE_AUTH_GATEWAY'
  );
  RETURN true;
END $fn$;

REVOKE ALL ON FUNCTION public.record_auth_gateway_failure(text,uuid,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_auth_gateway_failure(text,uuid,uuid)
 TO service_role;

UPDATE private.audit_event_catalog
SET category='SECURITY',severity='CRITICAL',retention_class='SECURITY',
 implementation_status=CASE WHEN implementation_status='OBSERVED' THEN 'OBSERVED'
 ELSE 'IMPLEMENTED' END,
 label_it=CASE action
 WHEN 'AUTH_LOGIN_FAILED' THEN 'Credenziali di accesso staff respinte da GoTrue'
 ELSE 'Codice MFA respinto da GoTrue' END
WHERE action IN ('AUTH_LOGIN_FAILED','MFA_VERIFICATION_FAILED');

CREATE TRIGGER audit_gateway_auth_failure_observed
AFTER INSERT ON public.audit_log
FOR EACH ROW
WHEN (NEW.action IN ('AUTH_LOGIN_FAILED','MFA_VERIFICATION_FAILED'))
EXECUTE FUNCTION private.mark_privacy_event_observed();
