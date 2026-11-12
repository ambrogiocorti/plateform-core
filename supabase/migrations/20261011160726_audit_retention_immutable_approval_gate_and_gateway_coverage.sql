-- Fail-closed retention governance: no application role can authorize a purge.
-- Binding legal periods and true object-lock custody require independent approval.
CREATE TABLE IF NOT EXISTS private.audit_retention_governance (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  policy_status text NOT NULL DEFAULT 'AWAITING_FORMAL_APPROVAL'
    CHECK (policy_status IN ('AWAITING_FORMAL_APPROVAL','APPROVED')),
  purge_enabled boolean NOT NULL DEFAULT false CHECK (purge_enabled=false),
  legal_hold boolean NOT NULL DEFAULT true CHECK(legal_hold=true),
  external_worm_verified_at timestamptz,
  dedicated_key_custody_verified_at timestamptz,
  retention_policy_approved_at timestamptz,
  retention_policy_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.audit_retention_governance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_retention_governance FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.audit_retention_governance(id)
VALUES(true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION private.audit_retention_governance_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN RAISE EXCEPTION 'AUDIT_RETENTION_APPROVAL_REQUIRES_VERSIONED_MIGRATION'; END $fn$;
REVOKE ALL ON FUNCTION private.audit_retention_governance_immutable()
 FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS audit_retention_governance_immutable
 ON private.audit_retention_governance;
CREATE TRIGGER audit_retention_governance_immutable
BEFORE UPDATE OR DELETE ON private.audit_retention_governance
FOR EACH ROW EXECUTE FUNCTION private.audit_retention_governance_immutable();

CREATE OR REPLACE FUNCTION public.get_auth_audit_readiness()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_native jsonb;
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 SELECT jsonb_build_object(
 'status',CASE WHEN count(*)=0 THEN 'DATABASE_SINK_NOT_VERIFIED'
   ELSE 'NATIVE_EVENTS_PRESENT_OUTCOMES_UNCLASSIFIED' END,
 'native_rows',count(*),
 'login_attempts',count(*) FILTER (WHERE payload->>'action'='login'),
 'mfa_verification_attempts',count(*) FILTER (WHERE payload->>'action'='verification_attempted'),
 'latest_event_at',max(created_at),
 'login_failures_certified',false,
 'mfa_failures_certified',false
 ) INTO v_native FROM auth.audit_log_entries;
 RETURN v_native||jsonb_build_object(
 'gateway_login_failures_observed',
  (SELECT count(*) FROM public.audit_log a
   WHERE a.action='AUTH_LOGIN_FAILED' AND a.emitter_source='EDGE_AUTH_GATEWAY'),
 'gateway_mfa_failures_observed',
  (SELECT count(*) FROM public.audit_log a
   WHERE a.action='MFA_VERIFICATION_FAILED' AND a.emitter_source='EDGE_AUTH_GATEWAY'),
 'gateway_scope','PLATEFORM_STAFF_FRONTEND_ONLY',
 'native_outcomes_verified',false);
END $fn$;
REVOKE ALL ON FUNCTION public.get_auth_audit_readiness() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_auth_audit_readiness() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_audit_retention_readiness()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_record private.audit_retention_governance;
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 SELECT * INTO v_record FROM private.audit_retention_governance WHERE id;
 RETURN jsonb_build_object(
  'status',v_record.policy_status,
  'audit_purge_enabled',v_record.purge_enabled,
  'legal_hold_active',v_record.legal_hold,
  'external_worm_certified',v_record.external_worm_verified_at IS NOT NULL,
  'external_key_custody_certified',v_record.dedicated_key_custody_verified_at IS NOT NULL,
  'retention_policy_approved',v_record.retention_policy_approved_at IS NOT NULL,
  'next_action','INDEPENDENT_WORM_KMS_AND_SIGNED_RETENTION_POLICY_REQUIRED');
END $fn$;
REVOKE ALL ON FUNCTION public.get_audit_retention_readiness()
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_audit_retention_readiness()
 TO authenticated;
