CREATE OR REPLACE FUNCTION public.list_audit_archive_checkpoints(
 p_after bigint DEFAULT 0,p_limit integer DEFAULT 50
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF p_after<0 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_ARCHIVE_VERIFY_WINDOW'; END IF;
 RETURN coalesce((
 SELECT jsonb_agg(to_jsonb(r) ORDER BY r.batch_no)
 FROM (SELECT batch_no,row_count,plaintext_sha256,payload_sha256,
   previous_chain_sha256,chain_sha256,ending_at,ending_id,object_path
   FROM private.audit_archive_batches
   WHERE batch_no>p_after ORDER BY batch_no LIMIT p_limit) r
 ),'[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.list_audit_archive_checkpoints(bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_audit_archive_checkpoints(bigint,integer) TO service_role;
