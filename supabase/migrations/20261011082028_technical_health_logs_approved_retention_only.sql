-- Health check log retention is separate from immutable audit retention.
-- No deletion unless the operator previously approved and enabled data retention.
CREATE OR REPLACE FUNCTION public.run_health_log_retention(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO ''
AS $body$
DECLARE v_config jsonb;v_days integer;v_removed integer:=0;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000
 THEN RAISE EXCEPTION 'INVALID_LIMIT';END IF;
 PERFORM pg_advisory_xact_lock(71467545);
 SELECT retention INTO v_config FROM public.restaurant_settings WHERE id;
 IF coalesce(v_config->>'enabled','false')<>'true'
    OR NOT coalesce(v_config ? 'configured_at',false)
 THEN RETURN jsonb_build_object('enabled',false,'health_removed',0);END IF;

 IF coalesce(v_config->>'error_days','') !~ '^[0-9]{1,4}$'
 THEN RAISE EXCEPTION 'INVALID_RETENTION_CONFIGURATION';END IF;
 v_days:=(v_config->>'error_days')::integer;
 IF v_days NOT BETWEEN 7 AND 3650
 THEN RAISE EXCEPTION 'INVALID_RETENTION_CONFIGURATION';END IF;

 DELETE FROM public.health_checks WHERE id IN (
  SELECT id FROM public.health_checks
  WHERE checked_at < now()-make_interval(days=>v_days)
  ORDER BY checked_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED
 );
 GET DIAGNOSTICS v_removed=ROW_COUNT;
 RETURN jsonb_build_object('enabled',true,'health_removed',v_removed,'health_days',v_days);
END $body$;

REVOKE ALL ON FUNCTION public.run_health_log_retention(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.run_health_log_retention(integer) TO service_role;

SELECT cron.schedule(
 'plateform-health-log-retention','43 3 * * *',
 'SELECT public.run_health_log_retention(200)'
);
