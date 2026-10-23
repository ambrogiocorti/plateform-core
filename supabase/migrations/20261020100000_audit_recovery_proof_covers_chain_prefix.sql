-- The audit-archive worker seals a batch every 15 minutes while recovery verification runs daily
-- (03:17). get_audit_certification_gates required the daily proof to end exactly on the live
-- cursor head, so any active installation showed ARCHIVE_RECOVERY_PROOF_NOT_CURRENT most of the
-- day. A proof now counts when it is PASS, at most 36 hours old, and ends on a sealed batch of the
-- current chain (checking that batch's last 25). Backlog, append-only, WORM, key custody and
-- retention gates are unchanged. Body otherwise identical to 20261018103000.

CREATE OR REPLACE FUNCTION public.get_audit_certification_gates()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE c private.audit_archive_cursor;
DECLARE v private.audit_archive_verification_runs;
DECLARE g private.audit_retention_governance;
DECLARE audit_count bigint;
DECLARE archived_count bigint;
DECLARE native_count bigint;
DECLARE login_count bigint;
DECLARE mfa_count bigint;
DECLARE remaining_older_than_grace bigint;
DECLARE proof_current boolean;
DECLARE hold_safe boolean;
DECLARE append_only_violations text[];
DECLARE ddl_guard_installed boolean;
DECLARE reasons text[];
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 SELECT * INTO c FROM private.audit_archive_cursor WHERE id;
 SELECT * INTO g FROM private.audit_retention_governance WHERE id;
 SELECT * INTO v FROM private.audit_archive_verification_runs
 ORDER BY checked_at DESC,id DESC LIMIT 1;
 SELECT count(*) INTO audit_count FROM public.audit_log;
 SELECT coalesce(sum(row_count),0) INTO archived_count FROM private.audit_archive_batches;
 SELECT count(*) INTO native_count FROM auth.audit_log_entries;
 SELECT count(*) INTO login_count FROM public.audit_log
 WHERE action='AUTH_LOGIN_FAILED' AND emitter_source='EDGE_AUTH_GATEWAY';
 SELECT count(*) INTO mfa_count FROM public.audit_log
 WHERE action='MFA_VERIFICATION_FAILED' AND emitter_source='EDGE_AUTH_GATEWAY';
 SELECT count(*) INTO remaining_older_than_grace FROM public.audit_log a
 WHERE (a.timestamp,a.id)>(c.last_event_at,c.last_event_id)
   AND a.timestamp<clock_timestamp()-interval '30 minutes';
 proof_current:=coalesce(
  v.result='PASS'
  AND v.checked_at>clock_timestamp()-interval '36 hours'
  -- The proof covers the chain up to the batch it ended on; batches sealed after it extend that
  -- same hash chain and are covered by the next daily run (36 h freshness above).
  AND EXISTS (
   SELECT 1 FROM private.audit_archive_batches b
   WHERE b.chain_sha256=v.final_chain_sha256
     AND b.batch_no<=c.last_batch
     AND v.checked_batches=least(b.batch_no,25)
  )
  AND v.checked_rows>0
  ,false);
 hold_safe:=coalesce(g.legal_hold AND NOT g.purge_enabled,false);
 append_only_violations:=private.audit_append_only_violations(true);
 SELECT count(*)=2 INTO ddl_guard_installed FROM pg_catalog.pg_event_trigger
 WHERE evtname IN ('plateform_audit_ddl_guard','plateform_audit_drop_guard')
   AND evtenabled IN ('O','A');
 reasons:=array_remove(ARRAY[
  CASE WHEN cardinality(append_only_violations)>0 THEN 'AUDIT_APPEND_ONLY_GUARD_VIOLATED' END,
  CASE WHEN NOT ddl_guard_installed THEN 'AUDIT_DDL_GUARD_NOT_INSTALLED' END,
  CASE WHEN login_count=0 THEN 'LOGIN_FAILURE_NOT_OBSERVED' END,
  CASE WHEN mfa_count=0 THEN 'MFA_FAILURE_NOT_OBSERVED' END,
  CASE WHEN native_count=0 THEN 'NATIVE_AUTHSINK_NOT_VERIFIED' END,
  CASE WHEN NOT proof_current THEN 'ARCHIVE_RECOVERY_PROOF_NOT_CURRENT' END,
  CASE WHEN remaining_older_than_grace>0 THEN 'ARCHIVE_BACKLOG_EXCEEDS_GRACE' END,
  CASE WHEN NOT hold_safe THEN 'AUDIT_LEGAL_HOLD_UNSAFE' END,
  CASE WHEN g.external_worm_verified_at IS NULL THEN 'EXTERNAL_WORM_NOT_CERTIFIED' END,
  CASE WHEN g.dedicated_key_custody_verified_at IS NULL THEN 'INDEPENDENT_KEY_CUSTODY_NOT_CERTIFIED' END,
  CASE WHEN g.retention_policy_approved_at IS NULL THEN 'RETENTION_POLICY_NOT_APPROVED' END
 ]::text[],NULL);
 RETURN jsonb_build_object(
  'overall_status',CASE WHEN cardinality(reasons)=0 THEN 'AUDIT_CERTIFIED'
                       ELSE 'CERTIFICATION_BLOCKED' END,
  'reasons',to_jsonb(reasons),
  'checked_at',clock_timestamp(),
  'append_only_violations',to_jsonb(append_only_violations),
  'ddl_guard_installed',ddl_guard_installed,
  'login_failures_observed',login_count,
  'mfa_failures_observed',mfa_count,
  'native_auth_records',native_count,
  'audit_events',audit_count,
  'archived_events',archived_count,
  'archive_batch_count',coalesce(c.last_batch,0),
  'archive_recovery_current',proof_current,
  'archive_overdue_events',remaining_older_than_grace,
  'legal_hold_active',coalesce(g.legal_hold,false),
  'audit_purge_enabled',coalesce(g.purge_enabled,true),
  'external_worm_certified',g.external_worm_verified_at IS NOT NULL,
  'dedicated_key_custody_certified',g.dedicated_key_custody_verified_at IS NOT NULL,
  'retention_policy_approved',g.retention_policy_approved_at IS NOT NULL
 );
END $body$;
REVOKE ALL ON FUNCTION public.get_audit_certification_gates() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_audit_certification_gates() TO authenticated;
