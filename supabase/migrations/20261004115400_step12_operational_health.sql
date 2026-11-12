begin;

create or replace function public.get_technical_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  result jsonb;
  metrics jsonb;
  backup_health jsonb;
begin
  result:=private.technical_workspace_base();

  with recent as (
    select created_at,
           (properties->>'status')::integer status,
           case
             when properties->>'duration_ms' ~ '^[0-9]{1,5}$'
              and (properties->>'duration_ms')::integer<=60000
             then (properties->>'duration_ms')::integer
           end duration_ms
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
    'pending_count',(select count(*) from public.backup_metadata where status in ('QUEUED','RUNNING')),
    'failed_24h',(select count(*) from public.backup_metadata where status='FAILED' and completed_at>now()-interval '24 hours'),
    'expiring_7d',(select count(*) from public.backup_metadata where status='SUCCEEDED' and retention_until between now() and now()+interval '7 days'),
    'latest_status',(select status from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_integrity_verified',(select integrity_verified from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_retention_until',(select retention_until from public.backup_metadata order by created_at desc,id desc limit 1),
    'restore_pending_count',(select count(*) from public.restore_jobs where status in ('REQUESTED','SNAPSHOTTING','RESTORING','VERIFYING')),
    'restore_failed_24h',(select count(*) from public.restore_jobs where status='FAILED' and completed_at>now()-interval '24 hours'),
    'latest_restore_status',(select status from public.restore_jobs order by created_at desc,id desc limit 1),
    'cron_active',coalesce((select bool_or(active) from cron.job where jobname='plateform-daily-backup'),false)
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
    'restores',coalesce((
      select jsonb_agg(to_jsonb(x) order by created_at desc)
        from (
          select id,backup_id,pre_restore_backup_id,scope,status,mode,reason,
                 created_at,confirmed_at,completed_at,error_code,target_reference,attempts
            from public.restore_jobs
           order by created_at desc,id desc
           limit 10
        ) x
    ),'[]'::jsonb)
  );
end $$;

commit;