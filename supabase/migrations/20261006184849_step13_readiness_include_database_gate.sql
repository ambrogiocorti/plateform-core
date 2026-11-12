CREATE OR REPLACE FUNCTION public.release_readiness_report()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_security jsonb;
  v_database jsonb;
  v_active_incidents integer;
  v_severe_incidents integer;
  v_active_backups integer;
  v_usable_backups integer;
  v_restore_tests integer;
  v_cron integer;
  v_manual_pending integer;
  v_internal_ready boolean;
  v_manual jsonb;
  v_release jsonb;
begin
  v_security:=public.release_security_gate();
  v_database:=public.release_database_regression_gate();

  select count(*)::integer,
         count(*) filter(where severity in ('INCIDENT','CRITICAL'))::integer
    into v_active_incidents,v_severe_incidents
  from public.incidents
  where status::text<>'RESOLVED';

  select
    count(*) filter(where status in ('QUEUED','RUNNING'))::integer,
    count(*) filter(
      where status='SUCCEEDED'
        and integrity_verified
        and artifacts_purged_at is null
    )::integer
  into v_active_backups,v_usable_backups
  from public.backup_metadata;

  select count(*)::integer
    into v_restore_tests
  from public.restore_jobs
  where mode='TEST' and status='SUCCEEDED';

  select count(*)::integer
    into v_cron
  from cron.job
  where active
    and jobname in (
      'plateform-daily-backup',
      'plateform-continuity-alerts',
      'plateform-backup-worker',
      'plateform-retention-worker'
    );

  select count(*) filter(where required and status<>'PASS')::integer,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'key',key,
               'category',category,
               'required',required,
               'status',status,
               'evidence',evidence,
               'checked_at',checked_at,
               'checked_by',checked_by
             )
             order by category,key
           ),
           '[]'::jsonb
         )
    into v_manual_pending,v_manual
  from private.release_gate_checks;

  select to_jsonb(r)
    into v_release
  from public.application_releases r
  order by released_at desc
  limit 1;

  v_internal_ready:=
    coalesce((v_security->>'ok')::boolean,false)
    and coalesce((v_database->>'ok')::boolean,false)
    and v_active_incidents=0
    and v_severe_incidents=0
    and v_active_backups=0
    and v_usable_backups>0
    and v_restore_tests>0
    and v_cron=4;

  return jsonb_build_object(
    'internal_ready',v_internal_ready,
    'go_live_ready',v_internal_ready and v_manual_pending=0,
    'security',v_security,
    'database',v_database,
    'continuity',jsonb_build_object(
      'active_incidents',v_active_incidents,
      'severe_incidents',v_severe_incidents,
      'active_backups',v_active_backups,
      'usable_verified_backups',v_usable_backups,
      'successful_restore_tests',v_restore_tests,
      'required_cron_jobs_active',v_cron
    ),
    'manual_required_pending',v_manual_pending,
    'manual_checks',v_manual,
    'latest_release',v_release,
    'checked_at',clock_timestamp()
  );
end
$function$
