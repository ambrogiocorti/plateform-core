-- Server-authoritative Super Admin Audit export with one-use password step-up.
-- Never export IP, user agent, client-supplied metadata or external secrets.
CREATE OR REPLACE FUNCTION private.authorize_sensitive_action_base(
 p_action text,p_resource uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE venue uuid;actor uuid;
BEGIN
 CASE p_action
 WHEN 'REFUND','CANCEL_PAYMENT' THEN
   SELECT venue_id INTO venue FROM public.payments WHERE id=p_resource;
   IF venue IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
   actor:=private.authorize(venue,ARRAY['ADMIN']::public.user_role[]);
 WHEN 'FORCE_CLOSE','REOPEN_ACCOUNT' THEN
   SELECT venue_id INTO venue FROM public.accounts WHERE id=p_resource;
   IF venue IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
   actor:=private.authorize(venue,ARRAY['ADMIN']::public.user_role[]);
 WHEN 'DISCOUNT_APPROVAL' THEN
   SELECT venue_id INTO venue FROM public.discount_requests WHERE id=p_resource;
   IF venue IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
   actor:=private.authorize(venue,ARRAY['ADMIN']::public.user_role[]);
 WHEN 'CASH_RECONCILIATION' THEN
   SELECT venue_id INTO venue FROM public.cash_reconciliation_requests WHERE id=p_resource;
   IF venue IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
   actor:=private.authorize(venue,ARRAY['ADMIN']::public.user_role[]);
 WHEN 'FEATURE_CHANGE','INSTALLATION_STATUS','IMPERSONATION','RESTORE','DECOMMISSION','PRIVILEGED_STAFF','AUDIT_EXPORT' THEN
   actor:=private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[]);
 WHEN 'STAFF_CHANGE' THEN
   actor:=private.authorize(NULL,ARRAY['ADMIN','SUPER_ADMIN']::public.user_role[]);
 ELSE RAISE EXCEPTION 'UNKNOWN_SENSITIVE_ACTION';
 END CASE;
 IF private.impersonation_id() IS NOT NULL THEN
   RAISE EXCEPTION 'EXIT_IMPERSONATION_FOR_STEP_UP';
 END IF;
 RETURN jsonb_build_object('user_id',actor,'session_id',private.jwt_session_id());
END $fn$;

CREATE OR REPLACE FUNCTION public.export_audit_professional(
 p_grant uuid,
 p_reason text,
 p_from timestamptz,
 p_to timestamptz,
 p_limit integer DEFAULT 500
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE result jsonb;total integer;
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[]);
 IF p_grant IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 8 AND 240
   OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to>now()+interval '1 minute'
   OR p_to-p_from>interval '31 days'
   OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
 THEN RAISE EXCEPTION 'INVALID_AUDIT_EXPORT';END IF;
 PERFORM private.consume_step_up(p_grant,'AUDIT_EXPORT',NULL);
 SELECT count(*) INTO total FROM
  (SELECT a.id FROM public.audit_log a WHERE a.timestamp>=p_from AND a.timestamp<=p_to
     ORDER BY a.timestamp DESC,a.id DESC LIMIT p_limit+1) limited;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.timestamp DESC,x.id DESC),'[]'::jsonb)
 INTO result
 FROM (
  SELECT a.id,a.timestamp,a.actor_type,a.actor_user_id,a.actor_role,
         a.venue_id,a.action,a.resource_type,a.resource_id,a.operation,a.result,
         a.request_id,a.correlation_id,a.impersonated_by,
         a.old_values,a.new_values,a.reason_code,a.emitter_source,
         coalesce(c.category,'UNCATALOGUED') category,coalesce(c.severity,'ELEVATED') severity
  FROM public.audit_log a
  LEFT JOIN private.audit_event_catalog c ON c.action=a.action
  WHERE a.timestamp>=p_from AND a.timestamp<=p_to
  ORDER BY a.timestamp DESC,a.id DESC LIMIT p_limit
 ) x;
 -- Committed in the same transaction as the returned data.
 PERFORM private.audit('AUDIT_EXPORTED','audit_log',NULL,NULL,NULL,
  jsonb_build_object('reason',trim(p_reason),'purpose','AUDIT_EXPORT'));
 RETURN jsonb_build_object(
  'generated_at',clock_timestamp(),'window_start',p_from,'window_end',p_to,
  'rows',result,'has_more',total>p_limit,'limit',p_limit);
END $fn$;
REVOKE ALL ON FUNCTION public.export_audit_professional(uuid,text,timestamptz,timestamptz,integer)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.export_audit_professional(uuid,text,timestamptz,timestamptz,integer)
 TO authenticated;

UPDATE private.audit_event_catalog SET implementation_status='IMPLEMENTED',
 category='SECURITY',severity='CRITICAL',retention_class='SECURITY',
 label_it='Registro audit esportato da Super Admin',
 requires_reason=true,requires_approval=true
 WHERE action='AUDIT_EXPORTED' AND implementation_status='PLANNED';

CREATE TRIGGER audit_export_event_observed
AFTER INSERT ON public.audit_log
FOR EACH ROW WHEN (NEW.action='AUDIT_EXPORTED')
EXECUTE FUNCTION private.mark_privacy_event_observed();
