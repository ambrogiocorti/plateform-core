-- Independent archive readback proof, append-only; no audit deletion.
CREATE TABLE IF NOT EXISTS private.audit_archive_verification_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 result text NOT NULL CHECK(result IN ('PASS','FAIL')),
 checked_batches integer NOT NULL CHECK(checked_batches>=0),
 checked_rows integer NOT NULL CHECK(checked_rows>=0),
 final_chain_sha256 text,
 failure_code text,
 CONSTRAINT verification_chain_format CHECK(final_chain_sha256 IS NULL OR final_chain_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT verification_failure_code CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,80}$')
);
ALTER TABLE private.audit_archive_verification_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.audit_archive_verification_runs FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS immutable_audit_archive_verifications ON private.audit_archive_verification_runs;
CREATE TRIGGER immutable_audit_archive_verifications BEFORE UPDATE OR DELETE ON private.audit_archive_verification_runs
FOR EACH ROW EXECUTE FUNCTION private.audit_archive_batch_immutable();

CREATE OR REPLACE FUNCTION public.record_audit_archive_verification(
 p_pass boolean,p_batches integer,p_rows integer,p_chain text,p_failure_code text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_pass IS NULL OR p_batches NOT BETWEEN 0 AND 100000000 OR p_rows NOT BETWEEN 0 AND 2147483647
 OR (p_chain IS NOT NULL AND p_chain !~ '^[a-f0-9]{64}$')
 OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[A-Z0-9_]{1,80}$')
 THEN RAISE EXCEPTION 'INVALID_AUDIT_ARCHIVE_PROOF'; END IF;
 INSERT INTO private.audit_archive_verification_runs(result,checked_batches,checked_rows,final_chain_sha256,failure_code)
 VALUES(CASE WHEN p_pass THEN 'PASS' ELSE 'FAIL' END,p_batches,p_rows,p_chain,
 CASE WHEN p_pass THEN NULL ELSE coalesce(p_failure_code,'UNKNOWN_FAILURE') END);
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.record_audit_archive_verification(boolean,integer,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_audit_archive_verification(boolean,integer,integer,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_audit_archive_health()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 RETURN (
 SELECT jsonb_build_object(
 'last_batch',c.last_batch,'last_archived_at',c.last_event_at,
 'archived_rows',(SELECT coalesce(sum(row_count),0) FROM private.audit_archive_batches),
 'remaining_rows',(SELECT count(*) FROM public.audit_log a WHERE (a.timestamp,a.id)>(c.last_event_at,c.last_event_id)),
 'latest_verification',(SELECT to_jsonb(v) FROM private.audit_archive_verification_runs v ORDER BY checked_at DESC LIMIT 1)
 ) FROM private.audit_archive_cursor c WHERE c.id);
END $fn$;
REVOKE ALL ON FUNCTION public.get_audit_archive_health() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_audit_archive_health() TO authenticated;
