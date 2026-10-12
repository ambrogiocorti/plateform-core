-- Trusted step-up password failure reporting. Only the server service role may call.
-- Never collect the attempted password, email, IP or browser identifiers.
CREATE OR REPLACE FUNCTION public.record_step_up_denial(
 p_user uuid,p_session uuid,p_action text
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE v_role public.user_role;
BEGIN
 IF p_user IS NULL OR p_session IS NULL OR
    p_action IS NULL OR length(p_action) NOT BETWEEN 1 AND 50 OR
    p_action !~ '^[A-Z][A-Z0-9_]*$'
 THEN RAISE EXCEPTION 'INVALID_STEP_UP_DENIAL';END IF;
 SELECT sp.role INTO v_role
 FROM private.staff_sessions s JOIN public.staff_profiles sp ON sp.id=s.user_id
 WHERE s.session_id=p_session AND s.user_id=p_user
   AND s.revoked_at IS NULL AND s.unlocked_until>now() AND sp.active;
 IF v_role IS NULL THEN RAISE EXCEPTION 'INVALID_STEP_UP_DENIAL_CONTEXT';END IF;
 INSERT INTO public.audit_log(
 actor_type,actor_user_id,actor_role,action,resource_type,operation,result,
 session_id,old_values,new_values,request_id,correlation_id,emitter_source
 ) VALUES(
 'STAFF',p_user,v_role,'STEP_UP_FAILED','authentication','VERIFY','DENIED',
 p_session,'{}'::jsonb,jsonb_build_object('purpose',p_action),
 gen_random_uuid(),gen_random_uuid(),'EDGE_STEP_UP'
 );
END $fn$;
REVOKE ALL ON FUNCTION public.record_step_up_denial(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_step_up_denial(uuid,uuid,text)
 TO service_role;

INSERT INTO private.audit_event_catalog
(action,category,severity,retention_class,label_it,requires_reason,requires_approval,implementation_status)
VALUES('STEP_UP_FAILED','SECURITY','CRITICAL','SECURITY',
'Nuova verifica password non riuscita',false,false,'IMPLEMENTED')
ON CONFLICT(action) DO UPDATE SET
 category=excluded.category,severity=excluded.severity,
 implementation_status=CASE WHEN private.audit_event_catalog.implementation_status='OBSERVED'
 THEN 'OBSERVED' ELSE 'IMPLEMENTED' END;

CREATE TRIGGER audit_step_up_denial_observed
AFTER INSERT ON public.audit_log
FOR EACH ROW WHEN(NEW.action='STEP_UP_FAILED')
EXECUTE FUNCTION private.mark_privacy_event_observed();
