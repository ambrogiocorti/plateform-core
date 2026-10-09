
create or replace function private.refresh_internal_health_checks()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request uuid := gen_random_uuid();
  v_started timestamptz := clock_timestamp();
  v_db_latency integer;
  v_rpo integer;
  v_latest_backup timestamptz;
  v_backup_ok boolean;
  v_edge_ok boolean;
  v_stripe boolean;
  v_satispay boolean;
  v_print_devices integer;
begin
  perform 1;
  v_db_latency := greatest(
    0,
    least(
      60000,
      round(extract(epoch from (clock_timestamp()-v_started))*1000)::integer
    )
  );

  select rpo_target_minutes into v_rpo
  from private.continuity_settings
  where id;

  select max(completed_at) into v_latest_backup
  from public.backup_metadata
  where status='SUCCEEDED'
    and integrity_verified
    and artifacts_purged_at is null;

  v_backup_ok :=
    v_latest_backup is not null
    and v_latest_backup >= clock_timestamp()-make_interval(mins=>coalesce(v_rpo,60)+15);

  v_edge_ok :=
    exists(
      select 1 from private.continuity_worker_heartbeats
      where worker='BACKUP'
        and last_seen_at>clock_timestamp()-interval '10 minutes'
        and status<>'ERROR'
    )
    and exists(
      select 1 from private.continuity_worker_heartbeats
      where worker='RETENTION'
        and last_seen_at>clock_timestamp()-interval '10 minutes'
        and status<>'ERROR'
    );

  select licensed into v_stripe from public.feature_flags where name='STRIPE';
  select licensed into v_satispay from public.feature_flags where name='SATISPAY_API';
  select count(*)::integer into v_print_devices from public.print_devices where active;

  perform public.record_health_probe('DATABASE','HEALTHY',v_db_latency,'PROBE_OK',v_request);

  perform public.record_health_probe(
    'BACKUP',
    case when v_backup_ok then 'HEALTHY' else 'DEGRADED' end,
    null,
    case when v_backup_ok then 'PROBE_OK' else 'PROBE_FAILED' end,
    v_request
  );

  perform public.record_health_probe(
    'EDGE',
    case when v_edge_ok then 'HEALTHY' else 'DEGRADED' end,
    null,
    case when v_edge_ok then 'PROBE_OK' else 'PROBE_FAILED' end,
    v_request
  );

  perform public.record_health_probe('AUTH','UNVERIFIED',null,'CONFIGURED_UNTESTED',v_request);
  perform public.record_health_probe('REALTIME','UNVERIFIED',null,'CONFIGURED_UNTESTED',v_request);
  perform public.record_health_probe('STORAGE','UNVERIFIED',null,'CONFIGURED_UNTESTED',v_request);

  perform public.record_health_probe(
    'STRIPE',
    case when coalesce(v_stripe,false) then 'UNVERIFIED' else 'DISABLED' end,
    null,
    case when coalesce(v_stripe,false) then 'CONFIGURED_UNTESTED' else 'DISABLED' end,
    v_request
  );

  perform public.record_health_probe(
    'SATISPAY',
    case when coalesce(v_satispay,false) then 'UNVERIFIED' else 'DISABLED' end,
    null,
    case when coalesce(v_satispay,false) then 'CONFIGURED_UNTESTED' else 'DISABLED' end,
    v_request
  );

  perform public.record_health_probe(
    'PRINT',
    case when coalesce(v_print_devices,0)>0 then 'UNVERIFIED' else 'DISABLED' end,
    null,
    case when coalesce(v_print_devices,0)>0 then 'CONFIGURED_UNTESTED' else 'DISABLED' end,
    v_request
  );

  delete from public.health_checks
  where checked_at < clock_timestamp()-interval '7 days';

  return jsonb_build_object(
    'request_id',v_request,
    'database','HEALTHY',
    'backup',case when v_backup_ok then 'HEALTHY' else 'DEGRADED' end,
    'edge',case when v_edge_ok then 'HEALTHY' else 'DEGRADED' end,
    'checked_at',clock_timestamp()
  );
end
$$;

revoke all on function private.refresh_internal_health_checks()
from public,anon,authenticated;

grant execute on function private.refresh_internal_health_checks()
to service_role,postgres;

select cron.schedule(
  'plateform-health-snapshot',
  '*/5 * * * *',
  'select private.refresh_internal_health_checks();'
);
