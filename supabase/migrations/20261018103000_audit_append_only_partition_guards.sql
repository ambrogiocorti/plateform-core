-- Macro-step A.1: audit append-only hardening.
-- No audit row is inserted, updated, deleted, moved or rewritten here.
-- 1. Remove the legacy Development pause trigger (and its function) so no
--    path can be re-enabled to discard audit INSERTs.
-- 2. Guard every audit partition: TRUNCATE trigger, guards ENABLE ALWAYS
--    (also active with session_replication_role=replica), least privilege.
-- 3. Future-partition rotation applies the same guards and verifies them.
-- 4. A read-only invariant check feeds the SUPER_ADMIN certification gate.
-- 5. A DDL event trigger rejects tampering where the platform permits it.

-- 1. Legacy pause trigger: drop parent triggers (cloned partition triggers
--    go with them) and any standalone copy on a partition.
DO $plateform$
DECLARE
  r record;
  v_functions oid[]:='{}';
BEGIN
  FOR r IN
    SELECT t.tgname,t.tgrelid,t.tgfoid
    FROM pg_catalog.pg_trigger t
    WHERE t.tgname='plateform_dev_pause_audit'
      AND t.tgparentid=0
      AND t.tgrelid IN (
        SELECT relid FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
      )
  LOOP
    v_functions:=v_functions||r.tgfoid;
    EXECUTE format('DROP TRIGGER %I ON %s',r.tgname,r.tgrelid::regclass);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgname='plateform_dev_pause_audit'
      AND t.tgrelid IN (
        SELECT relid FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
      )
  ) THEN
    RAISE EXCEPTION 'AUDIT_PAUSE_TRIGGER_NOT_REMOVED';
  END IF;
  -- Drop only functions left without any trigger; never the shared guard.
  FOR r IN
    SELECT DISTINCT p.oid
    FROM pg_catalog.pg_proc p
    WHERE p.oid=ANY(v_functions)
      AND p.oid<>'private.immutable_record()'::regprocedure
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid)
  LOOP
    EXECUTE format('DROP FUNCTION %s',r.oid::regprocedure);
  END LOOP;
END
$plateform$;
DROP FUNCTION IF EXISTS private.plateform_legacy_audit_pause_noop();

-- 2. Per-table guard, idempotent.
CREATE OR REPLACE FUNCTION private.guard_audit_table(p_table regclass)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $body$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
  WHERE relid=p_table
 ) THEN
  RAISE EXCEPTION 'AUDIT_TABLE_NOT_IN_PARTITION_TREE';
 END IF;
 -- Privileges first: the DDL guard checks them on every later statement.
 -- TRIGGER privilege would allow attaching a discarding BEFORE INSERT trigger.
 IF p_table='public.audit_log'::regclass THEN
  EXECUTE format(
   'REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',
   p_table
  );
 ELSE
  -- Partitions are reached only through the parent (and its RLS policy).
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',p_table);
 END IF;
 -- Statement-level TRUNCATE triggers are not cloned to partitions.
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger
  WHERE tgrelid=p_table AND tgname='audit_no_truncate'
 ) THEN
  EXECUTE format(
   'CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION private.immutable_record()',
   p_table
  );
 END IF;
 EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER audit_immutable',p_table);
 EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER audit_no_truncate',p_table);
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',p_table);
END $body$;
REVOKE ALL ON FUNCTION private.guard_audit_table(regclass)
 FROM PUBLIC,anon,authenticated,service_role;

-- 4. Read-only invariants. p_full=false (enforced by the event trigger) skips
--    only what a partition lacks between CREATE TABLE and its guard setup:
--    the TRUNCATE trigger, ENABLE ALWAYS and RLS.
CREATE OR REPLACE FUNCTION private.audit_append_only_violations(p_full boolean DEFAULT true)
RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE
 r record;
 v text[]:='{}';
 v_guard constant oid:='private.immutable_record()'::regprocedure;
 v_enabled constant text[]:=CASE WHEN p_full THEN ARRAY['A'] ELSE ARRAY['O','A'] END;
 -- AFTER INSERT observers only flag that an event happened; they cannot
 -- drop the row. Any other trigger needs a reviewed migration.
 v_allowed constant text[]:=ARRAY[
  'audit_immutable','audit_no_truncate',
  'audit_export_event_observed','audit_gateway_auth_failure_observed',
  'audit_privacy_event_observed','audit_step_up_denial_observed'
 ];
BEGIN
 FOR r IN
  SELECT t.relid,t.relid::text AS name,t.level
  FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass) t
 LOOP
  IF NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_trigger g
   WHERE g.tgrelid=r.relid AND g.tgname='audit_immutable' AND g.tgfoid=v_guard
     AND (g.tgtype & 27)=27 AND g.tgenabled=ANY(v_enabled)
  ) THEN v:=v||('IMMUTABLE_GUARD_MISSING_OR_DISABLED:'||r.name); END IF;
  IF EXISTS (
   SELECT 1 FROM pg_catalog.pg_trigger g
   WHERE g.tgrelid=r.relid AND g.tgname='audit_no_truncate'
     AND NOT (g.tgfoid=v_guard AND (g.tgtype & 34)=34 AND g.tgenabled=ANY(v_enabled))
  ) OR (p_full AND NOT EXISTS (
   SELECT 1 FROM pg_catalog.pg_trigger g
   WHERE g.tgrelid=r.relid AND g.tgname='audit_no_truncate'
  )) THEN v:=v||('TRUNCATE_GUARD_MISSING_OR_DISABLED:'||r.name); END IF;
  v:=v||ARRAY(
   SELECT 'UNEXPECTED_TRIGGER:'||r.name||'.'||g.tgname
   FROM pg_catalog.pg_trigger g
   WHERE g.tgrelid=r.relid AND NOT g.tgisinternal
     AND (NOT g.tgname=ANY(v_allowed)
          OR (g.tgname NOT IN ('audit_immutable','audit_no_truncate')
              AND (g.tgtype & 66)<>0))
   ORDER BY g.tgname
  );
  v:=v||ARRAY(
   SELECT 'REWRITE_RULE:'||r.name||'.'||w.rulename
   FROM pg_catalog.pg_rewrite w
   WHERE w.ev_class=r.relid AND w.rulename<>'_RETURN'
   ORDER BY w.rulename
  );
  IF p_full AND NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid=r.relid)
  THEN v:=v||('RLS_DISABLED:'||r.name); END IF;
  v:=v||ARRAY(
   SELECT 'PRIVILEGE:'||r.name||':'||x0.role_name||':'||p.privilege
   FROM (VALUES ('public'),('anon'),('authenticated'),('service_role')) x0(role_name)
   CROSS JOIN LATERAL unnest(CASE
     WHEN r.level>0
      THEN ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
     ELSE ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END) p(privilege)
   WHERE has_table_privilege(x0.role_name,r.relid,p.privilege)
   ORDER BY 1
  );
 END LOOP;
 -- A detached partition keeps its rows outside every guard and query.
 v:=v||ARRAY(
  SELECT 'DETACHED_AUDIT_PARTITION:'||c.oid::regclass::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
    AND c.relname ~ '^audit_log_(default|[0-9]{4}_[0-9]{2})$'
    AND c.oid NOT IN (
     SELECT relid FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
    )
  ORDER BY 1
 );
 IF p_full AND NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_partitioned_table pt
  WHERE pt.partrelid='public.audit_log'::regclass AND pt.partdefid<>0
 ) THEN v:=v||'DEFAULT_PARTITION_MISSING'::text; END IF;
 RETURN v;
END $body$;
REVOKE ALL ON FUNCTION private.audit_append_only_violations(boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.audit_append_only_violations(boolean) TO service_role;

CREATE OR REPLACE FUNCTION private.assert_audit_append_only(p_full boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE v text[]:=private.audit_append_only_violations(p_full);
BEGIN
 IF cardinality(v)>0 THEN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY_VIOLATION'
   USING ERRCODE='42501',DETAIL=array_to_string(v,', ');
 END IF;
END $body$;
REVOKE ALL ON FUNCTION private.assert_audit_append_only(boolean)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.assert_audit_append_only(boolean) TO service_role;

-- Apply guards to the parent and every existing partition.
DO $plateform$
DECLARE r record;
BEGIN
 FOR r IN
  SELECT relid FROM pg_catalog.pg_partition_tree('public.audit_log'::regclass)
  ORDER BY level,relid::text
 LOOP
  PERFORM private.guard_audit_table(r.relid);
 END LOOP;
 PERFORM private.assert_audit_append_only(true);
END
$plateform$;

-- 3. Future partitions get the guards in the same transaction.
CREATE OR REPLACE FUNCTION private.ensure_audit_monthly_partitions(p_months integer DEFAULT 4)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE i integer;v_start timestamptz;v_end timestamptz;v_name text;v_total integer:=0;
BEGIN
 IF p_months IS NULL OR p_months NOT BETWEEN 1 AND 12
 THEN RAISE EXCEPTION 'INVALID_AUDIT_PARTITION_WINDOW';END IF;
 FOR i IN 1..p_months LOOP
  v_start:=(date_trunc('month',now() AT TIME ZONE 'UTC')
            + make_interval(months=>i)) AT TIME ZONE 'UTC';
  v_end:=v_start+interval '1 month';
  v_name:='audit_log_'||to_char(v_start AT TIME ZONE 'UTC','YYYY_MM');
  IF to_regclass(format('public.%I',v_name)) IS NULL THEN
   EXECUTE format(
     'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
     v_name,v_start,v_end
   );
   v_total:=v_total+1;
  END IF;
  PERFORM private.guard_audit_table(format('public.%I',v_name)::regclass);
 END LOOP;
 PERFORM private.assert_audit_append_only(true);
 RETURN v_total;
END $body$;
REVOKE ALL ON FUNCTION private.ensure_audit_monthly_partitions(integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_audit_monthly_partitions(integer)
 TO service_role;

-- 5. DDL tamper guard. Hosted platforms may refuse event triggers to
--    non-superusers, and superusers can always bypass them: this is defense
--    in depth, reported separately, never a substitute for privileges.
CREATE OR REPLACE FUNCTION private.audit_ddl_guard()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE r record;
BEGIN
 IF tg_event='sql_drop' THEN
  FOR r IN SELECT * FROM pg_catalog.pg_event_trigger_dropped_objects() LOOP
   IF (r.object_type='table' AND r.schema_name='public'
        AND r.object_identity ~ '^public\.audit_log(_default|_[0-9]{4}_[0-9]{2})?$')
      OR (r.object_type='trigger'
        AND r.object_identity ~ '^(audit_immutable|audit_no_truncate) on public\.audit_log')
      OR (r.object_type='function'
        AND r.object_identity IN ('private.immutable_record()','private.audit_ddl_guard()'))
   THEN
    RAISE EXCEPTION 'AUDIT_APPEND_ONLY_DDL_REJECTED'
     USING ERRCODE='42501',DETAIL=r.object_type||' '||r.object_identity;
   END IF;
  END LOOP;
 ELSE
  PERFORM private.assert_audit_append_only(false);
 END IF;
END $body$;
REVOKE ALL ON FUNCTION private.audit_ddl_guard() FROM PUBLIC,anon,authenticated,service_role;

DO $plateform$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname='plateform_audit_ddl_guard') THEN
  EXECUTE $ddl$CREATE EVENT TRIGGER plateform_audit_ddl_guard ON ddl_command_end
   WHEN TAG IN ('ALTER TABLE','CREATE TRIGGER','ALTER TRIGGER','CREATE RULE','GRANT','REVOKE')
   EXECUTE FUNCTION private.audit_ddl_guard()$ddl$;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname='plateform_audit_drop_guard') THEN
  EXECUTE $ddl$CREATE EVENT TRIGGER plateform_audit_drop_guard ON sql_drop
   EXECUTE FUNCTION private.audit_ddl_guard()$ddl$;
 END IF;
EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
 RAISE NOTICE 'AUDIT_DDL_EVENT_TRIGGER_NOT_INSTALLED: %',SQLERRM;
END
$plateform$;

-- Certification gate: same contract as before, plus append-only invariants.
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
  AND v.final_chain_sha256=c.last_chain_sha256
  AND v.checked_batches=least(c.last_batch,25)
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
