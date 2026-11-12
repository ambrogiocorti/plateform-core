begin;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.claim_backup_retention_job(integer)','service_role'),
  ('public.finish_backup_retention_job(uuid,uuid,boolean,text)','service_role'),
  ('public.reconcile_all_continuity_alerts()','service_role')
on conflict do nothing;

create or replace function public.get_technical_workspace()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb; metrics jsonb; backup_health jsonb; continuity jsonb;
begin
  result:=private.technical_workspace_base();
  select to_jsonb(c) into continuity from private.continuity_settings c where id;

  with recent as (
    select created_at,(properties->>'status')::integer status,
      case when properties->>'duration_ms' ~ '^[0-9]{1,5}$'
             and (properties->>'duration_ms')::integer<=60000
           then (properties->>'duration_ms')::integer end duration_ms
    from public.telemetry_events
    where created_at>now()-interval '15 minutes'
      and event in ('HTTP_SUCCESS','HTTP_FAILURE')
      and properties->>'status' ~ '^[2-5][0-9]{2}$'
  )
  select jsonb_build_object(
    'requests',count(*),
    'failures',count(*) filter(where status>=500),
    'error_percent',round(100.0*count(*) filter(where status>=500)/nullif(count(*),0),2),
    'latency_p95_ms',round(percentile_cont(.95) within group(order by duration_ms)::numeric),
    'latest_at',max(created_at)
  ) into metrics from recent;

  select jsonb_build_object(
    'last_success_at',(select max(completed_at) from public.backup_metadata where status='SUCCEEDED'),
    'last_failure_at',(select max(completed_at) from public.backup_metadata where status='FAILED'),
    'last_restore_test_at',(select max(last_restore_test_at) from public.backup_metadata),
    'last_backup_duration_seconds',(select extract(epoch from (completed_at-started_at))::bigint from public.backup_metadata where status='SUCCEEDED' and started_at is not null and completed_at is not null order by completed_at desc,id desc limit 1),
    'backup_age_minutes',(select round(extract(epoch from (now()-completed_at))/60.0,1) from public.backup_metadata where status='SUCCEEDED' and integrity_verified order by completed_at desc,id desc limit 1),
    'last_restore_test_duration_seconds',(select extract(epoch from (completed_at-coalesce(confirmed_at,created_at)))::bigint from public.restore_jobs where mode='TEST' and status='SUCCEEDED' and completed_at is not null order by completed_at desc,id desc limit 1),
    'rpo_within_target',(select case when max(completed_at) is null then false else max(completed_at)>=now()-make_interval(mins=>(continuity->>'rpo_target_minutes')::integer) end from public.backup_metadata where status='SUCCEEDED' and integrity_verified),
    'rto_last_test_within_target',(select case when completed_at is null then null else extract(epoch from (completed_at-coalesce(confirmed_at,created_at)))/60.0 <= (continuity->>'rto_target_minutes')::integer end from public.restore_jobs where mode='TEST' and status='SUCCEEDED' order by completed_at desc,id desc limit 1),
    'pending_count',(select count(*) from public.backup_metadata where status in ('QUEUED','RUNNING')),
    'failed_24h',(select count(*) from public.backup_metadata where status='FAILED' and completed_at>now()-interval '24 hours'),
    'expiring_7d',(select count(*) from public.backup_metadata where status='SUCCEEDED' and artifacts_purged_at is null and retention_until between now() and now()+interval '7 days'),
    'expired_unpurged_count',(select count(*) from public.backup_metadata where status='SUCCEEDED' and artifacts_purged_at is null and retention_until<=now()),
    'purge_in_progress_count',(select count(*) from public.backup_metadata where artifacts_purged_at is null and purge_lease_expires_at>now()),
    'purge_failed_count',(select count(*) from public.backup_metadata where artifacts_purged_at is null and purge_error_code is not null),
    'last_artifacts_purged_at',(select max(artifacts_purged_at) from public.backup_metadata),
    'latest_purge_error_code',(select purge_error_code from public.backup_metadata where purge_error_code is not null order by updated_at desc,id desc limit 1),
    'latest_status',(select status from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_integrity_verified',(select integrity_verified from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_retention_until',(select retention_until from public.backup_metadata order by created_at desc,id desc limit 1),
    'restore_pending_count',(select count(*) from public.restore_jobs where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')),
    'restore_failed_24h',(select count(*) from public.restore_jobs where status='FAILED' and completed_at>now()-interval '24 hours'),
    'latest_restore_status',(select status from public.restore_jobs order by created_at desc,id desc limit 1),
    'cron_active',coalesce((select bool_or(active) from cron.job where jobname='plateform-daily-backup'),false),
    'cron_schedule',(select schedule from cron.job where jobname='plateform-daily-backup' and active order by jobid desc limit 1)
  ) into backup_health;

  result:=jsonb_set(
    result,'{usage,recent_devices}',
    to_jsonb((
      select count(*)
      from public.registered_devices d
      left join private.device_heartbeats h on h.device_id=d.id
      where d.revoked_at is null
        and greatest(d.last_seen_at,h.last_seen_at)>now()-interval '5 minutes'
    ))
  );

  return result||jsonb_build_object(
    'metrics',metrics,
    'backup_health',backup_health,
    'continuity_targets',continuity,
    'restores',coalesce((
      select jsonb_agg(to_jsonb(x) order by created_at desc)
      from (
        select id,backup_id,pre_restore_backup_id,scope,status,mode,reason,
               created_at,confirmed_at,verified_at,cutover_confirmed_at,completed_at,
               error_code,target_reference,attempts
        from public.restore_jobs
        order by created_at desc,id desc
        limit 10
      ) x
    ),'[]'::jsonb)
  );
end $$;

commit;