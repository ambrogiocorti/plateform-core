-- Precreate only FUTURE monthly partitions. Never move/rewrite historical audit.
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
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',v_name);
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',v_name);
   v_total:=v_total+1;
  END IF;
 END LOOP;
 RETURN v_total;
END $body$;
REVOKE ALL ON FUNCTION private.ensure_audit_monthly_partitions(integer)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_audit_monthly_partitions(integer)
 TO service_role;

-- Monthly housekeeping creates partitions in advance; never purges historical data.
SELECT cron.schedule(
 'plateform-audit-future-partitions',
 '5 0 20 * *',
 'SELECT private.ensure_audit_monthly_partitions(4)'
);
-- Initial creation for next four UTC calendar months.
SELECT private.ensure_audit_monthly_partitions(4);
