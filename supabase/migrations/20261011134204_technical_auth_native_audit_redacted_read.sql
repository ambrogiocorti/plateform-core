-- Read-only native Supabase Auth audit source. Enable provider database
-- audit storage in Supabase settings before relying on actual event coverage.
CREATE OR REPLACE FUNCTION public.search_technical_logs(p_source text DEFAULT 'ALL'::text, p_from timestamp with time zone DEFAULT (now() - '7 days'::interval), p_to timestamp with time zone DEFAULT now(), p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_key text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM private.authorize(NULL,ARRAY['SUPER_ADMIN']::public.user_role[],false);
 IF p_source IS NULL OR p_source NOT IN('ALL','ERROR','EDGE','HEALTH','AUTH')
 OR p_from IS NULL OR p_to IS NULL OR p_from>p_to
 OR p_to>now()+interval '1 minute' OR p_to-p_from>interval '31 days'
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
 OR (p_before_at IS NULL)<>(p_before_key IS NULL)
 OR (p_before_key IS NOT NULL AND (length(p_before_key)>100 OR
   p_before_key !~ '^(ERROR|EDGE|HEALTH|AUTH):[A-Za-z0-9-]+$'))
 THEN RAISE EXCEPTION 'INVALID_TECHNICAL_LOG_FILTER'; END IF;

 RETURN (
 WITH raw_entries AS (
   SELECT e.created_at occurred_at,
     'ERROR'::text source,'ERROR'::text severity,
     'FAILURE'::text result,e.operation,e.code,
     e.request_id,e.correlation_id,
     ('ERROR:'||e.id::text) entry_key,
     NULL::integer latency_ms,NULL::text environment,NULL::text release_version
   FROM public.system_errors e
   WHERE p_source IN ('ALL','ERROR') AND e.created_at BETWEEN p_from AND p_to

   UNION ALL

   SELECT t.created_at,
     'EDGE'::text,
     CASE WHEN t.event='HTTP_FAILURE' THEN 'WARNING' ELSE 'INFO' END,
     CASE WHEN t.event='HTTP_FAILURE' THEN 'FAILURE' ELSE 'SUCCESS' END,
     left(coalesce(t.properties->>'operation','unknown'),80),
     left(coalesce(t.properties->>'code',t.event),80),
     t.request_id,t.correlation_id,
     ('EDGE:'||t.id::text),
     CASE WHEN t.properties->>'duration_ms' ~ '^[0-9]{1,6}$'
       THEN least((t.properties->>'duration_ms')::integer,60000)
       ELSE NULL::integer END,
     t.environment,t.release_version
   FROM public.telemetry_events t
   WHERE p_source IN ('ALL','EDGE')
     AND t.event IN ('HTTP_SUCCESS','HTTP_FAILURE')
     AND t.created_at BETWEEN p_from AND p_to

   UNION ALL

   SELECT h.checked_at,
     'HEALTH'::text,
     CASE WHEN h.status IN ('UNAVAILABLE','FAILED','CRITICAL') THEN 'ERROR'
          ELSE 'WARNING' END,
     h.status,
     left(h.component,80),left(h.code,80),
     h.request_id,NULL::uuid,
     ('HEALTH:'||h.id::text),
     h.latency_ms,NULL::text,NULL::text
   FROM public.health_checks h
   WHERE p_source IN ('ALL','HEALTH')
     AND h.status <> 'HEALTHY'
     AND h.checked_at BETWEEN p_from AND p_to

   UNION ALL

   -- Provider audit actions are not sufficient to infer login/MFA outcome.
   -- Raw payload, IP, email and user agent are excluded.
   SELECT a.created_at,
     'AUTH'::text,
     'INFO'::text,
     'RECORDED_UNCLASSIFIED'::text,
     'AUTH_PROVIDER_EVENT'::text,
     CASE WHEN (a.payload->>'action') ~ '^[a-z_]{1,60}$'
          THEN a.payload->>'action' ELSE 'UNKNOWN' END,
     NULL::uuid,NULL::uuid,
     ('AUTH:'||a.id::text),
     NULL::integer,NULL::text,NULL::text
   FROM auth.audit_log_entries a
   WHERE p_source IN ('ALL','AUTH') AND a.created_at BETWEEN p_from AND p_to
 ), page AS (
  SELECT *
  FROM raw_entries x
  WHERE p_before_at IS NULL OR (x.occurred_at,x.entry_key)<(p_before_at,p_before_key)
  ORDER BY occurred_at DESC,entry_key DESC LIMIT p_limit+1
 )
 SELECT jsonb_build_object(
   'events',coalesce((
    SELECT jsonb_agg(to_jsonb(v) ORDER BY v.occurred_at DESC,v.entry_key DESC)
    FROM (SELECT * FROM page ORDER BY occurred_at DESC,entry_key DESC LIMIT p_limit) v
   ),'[]'::jsonb),
   'has_more',(SELECT count(*)>p_limit FROM page)
 ));
END $function$;
REVOKE ALL ON FUNCTION public.search_technical_logs(
 text,timestamptz,timestamptz,timestamptz,text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.search_technical_logs(
 text,timestamptz,timestamptz,timestamptz,text,integer) TO authenticated;
