begin;

create table private.continuity_worker_heartbeats (
  worker text primary key check(worker in ('BACKUP','RETENTION','RESTORE_TEST','RESTORE')),
  status text not null check(status in ('POLLING','WORKING','IDLE','READY','ERROR')),
  last_seen_at timestamptz not null default clock_timestamp(),
  details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object' and octet_length(details::text)<=4096)
);
alter table private.continuity_worker_heartbeats enable row level security;
revoke all on private.continuity_worker_heartbeats from public,anon,authenticated;

create or replace function public.record_continuity_worker_heartbeat(
  p_worker text,
  p_status text,
  p_details jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare row private.continuity_worker_heartbeats;
begin
  if p_worker is null or p_worker not in ('BACKUP','RETENTION','RESTORE_TEST','RESTORE')
     or p_status is null or p_status not in ('POLLING','WORKING','IDLE','READY','ERROR')
     or jsonb_typeof(coalesce(p_details,'{}'::jsonb))<>'object'
     or octet_length(coalesce(p_details,'{}'::jsonb)::text)>4096 then
    raise exception 'INVALID_CONTINUITY_WORKER_HEARTBEAT';
  end if;
  insert into private.continuity_worker_heartbeats(worker,status,last_seen_at,details)
  values(p_worker,p_status,clock_timestamp(),coalesce(p_details,'{}'::jsonb))
  on conflict(worker) do update set
    status=excluded.status,
    last_seen_at=excluded.last_seen_at,
    details=excluded.details
  returning * into row;
  return jsonb_build_object(
    'worker',row.worker,
    'status',row.status,
    'last_seen_at',row.last_seen_at
  );
end $$;
revoke all on function public.record_continuity_worker_heartbeat(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_continuity_worker_heartbeat(text,text,jsonb) to service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.record_continuity_worker_heartbeat(text,text,jsonb)','service_role')
on conflict do nothing;

create or replace function public.reconcile_continuity_alerts()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  settings private.continuity_settings;
  latest_backup_failure timestamptz; latest_backup_success timestamptz;
  latest_restore_failure timestamptz; latest_restore_success timestamptz;
  latest_test_duration_minutes numeric;
  results jsonb := '[]'::jsonb; condition_active boolean;
begin
  select * into settings from private.continuity_settings where id;
  if settings.id is null then raise exception 'CONTINUITY_SETTINGS_REQUIRED'; end if;
  select max(completed_at) filter(where status='FAILED'),max(completed_at) filter(where status='SUCCEEDED' and integrity_verified)
    into latest_backup_failure,latest_backup_success from public.backup_metadata;
  select max(completed_at) filter(where status='FAILED'),max(completed_at) filter(where status='SUCCEEDED')
    into latest_restore_failure,latest_restore_success from public.restore_jobs;
  select extract(epoch from (completed_at-coalesce(confirmed_at,created_at)))/60.0 into latest_test_duration_minutes
    from public.restore_jobs where mode='TEST' and status='SUCCEEDED' order by completed_at desc,id desc limit 1;

  condition_active := not coalesce((select bool_or(j.active) from cron.job j where j.jobname='plateform-daily-backup'),false);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_CRON_INACTIVE',condition_active,'CRITICAL','Backup automatico non pianificato','Il job periodico che verifica il raggiungimento del target RPO non risulta attivo.','Verificare pg_cron e ripristinare plateform-daily-backup.'));

  condition_active := latest_backup_success is null or latest_backup_success < now()-make_interval(mins=>settings.rpo_target_minutes+15);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_VERIFIED_BACKUP_MISSING',condition_active,'WARNING','Backup verificato oltre target RPO',format('Non esiste un backup completo verificato entro il target RPO di %s minuti più 15 minuti di tolleranza.',settings.rpo_target_minutes),'Controllare worker, credenziali, destinazione persistente, manifest e verifica database/Auth/Storage.'));

  condition_active := latest_backup_failure is not null and latest_backup_failure > now()-interval '24 hours' and (latest_backup_success is null or latest_backup_success < latest_backup_failure);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_FAILED',condition_active,'INCIDENT','Backup fallito senza recupero successivo','L’ultimo esito rilevante del backup è un fallimento e non risulta un backup verificato successivo.','Aprire il dettaglio backup, correggere la causa e ottenere un backup SUCCEEDED con integrità verificata.'));

  condition_active := exists(select 1 from public.backup_metadata where (status='QUEUED' and created_at<now()-interval '30 minutes') or (status='RUNNING' and lease_expires_at<now()-interval '15 minutes'));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_QUEUE_STUCK',condition_active,'DEGRADED','Coda backup bloccata','Almeno un job backup è in attesa troppo a lungo o ha un lease scaduto non recuperato.','Verificare il worker esterno e reclamare in sicurezza i job con lease scaduto.'));

  condition_active := exists(select 1 from public.backup_metadata where status in ('QUEUED','RUNNING') and created_at<now()-interval '5 minutes')
    and not exists(select 1 from private.continuity_worker_heartbeats where worker='BACKUP' and last_seen_at>now()-interval '5 minutes');
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_WORKER_UNAVAILABLE',condition_active,'DEGRADED','Worker backup non rilevato','Esiste lavoro backup in attesa ma il worker BACKUP non invia heartbeat recente.','Verificare host continuity, timer systemd, rete server-side e credenziali del worker.'));

  condition_active := exists(select 1 from public.backup_metadata where status='SUCCEEDED' and artifacts_purged_at is null and retention_until<=now())
    and not exists(select 1 from private.continuity_worker_heartbeats where worker='RETENTION' and last_seen_at>now()-interval '45 minutes');
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RETENTION_WORKER_UNAVAILABLE',condition_active,'WARNING','Worker retention non rilevato','Esistono artifact scaduti da eliminare ma il worker RETENTION non invia heartbeat recente.','Verificare timer retention, filesystem backup/replica e host continuity.'));

  condition_active := latest_restore_failure is not null and latest_restore_failure > now()-interval '24 hours' and (latest_restore_success is null or latest_restore_success < latest_restore_failure);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_FAILED',condition_active,'CRITICAL','Restore o restore test fallito','Un restore recente è terminato con errore e non risulta un restore riuscito successivo.','Preservare gli artefatti, verificare target e manifest e seguire il runbook prima di un nuovo tentativo.'));

  condition_active := exists(select 1 from public.restore_jobs where status in ('SNAPSHOTTING','RESTORING','VERIFYING') and coalesce(confirmed_at,created_at)<now()-make_interval(mins=>settings.rto_target_minutes));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_STUCK',condition_active,'CRITICAL','Restore oltre target RTO',format('Un restore confermato non è terminato entro il target RTO di %s minuti.',settings.rto_target_minutes),'Non forzare retry distruttivi: verificare snapshot pre-restore, lease worker e target prima di intervenire.'));

  condition_active := exists(select 1 from public.restore_jobs where mode='TEST' and status in ('REQUESTED','SNAPSHOTTING','RESTORING','VERIFYING') and created_at<now()-interval '5 minutes')
    and not exists(select 1 from private.continuity_worker_heartbeats where worker='RESTORE_TEST' and last_seen_at>now()-interval '5 minutes');
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_TEST_WORKER_UNAVAILABLE',condition_active,'WARNING','Worker restore test non rilevato','Esiste un restore test da elaborare ma il worker RESTORE_TEST non invia heartbeat recente.','Verificare il preflight del target disposable e avviare restore-test-worker sul continuity host.'));

  condition_active := exists(select 1 from public.restore_jobs where mode='RESTORE' and status in ('CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING') and coalesce(confirmed_at,created_at)<now()-interval '5 minutes')
    and not exists(select 1 from private.continuity_worker_heartbeats where worker='RESTORE' and last_seen_at>now()-interval '5 minutes');
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_WORKER_UNAVAILABLE',condition_active,'CRITICAL','Worker restore non rilevato','Esiste un restore confermato da elaborare ma il worker RESTORE non invia heartbeat recente.','Non avviare retry distruttivi: verificare target replacement, preflight e worker restore sul continuity host.'));

  condition_active := not exists(select 1 from public.backup_metadata where status='SUCCEEDED' and integrity_verified and last_restore_test_at>=now()-make_interval(days=>settings.restore_test_interval_days));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_TEST_MISSING',condition_active,'WARNING','Restore test da verificare',format('Nessun backup ha superato un restore test isolato negli ultimi %s giorni.',settings.restore_test_interval_days),'Eseguire un restore test su un progetto disposable separato e completare tutti i controlli post-restore.'));

  condition_active := latest_test_duration_minutes is not null and latest_test_duration_minutes>settings.rto_target_minutes;
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RTO_TARGET_MISSED',condition_active,'DEGRADED','Restore test oltre target RTO',format('L’ultimo restore test ha richiesto %s minuti rispetto al target di %s minuti.',round(latest_test_duration_minutes,1),settings.rto_target_minutes),'Analizzare i tempi di restore e adeguare infrastruttura o target senza dichiarare SLA non verificati.'));

  return jsonb_build_object('checked_at',now(),'active_count',(select count(*) from public.incidents where automation_key like 'CONTINUITY_%' and status<>'RESOLVED'),'results',results);
end $$;
revoke all on function public.reconcile_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_continuity_alerts() to service_role,postgres;

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
    'cron_schedule',(select schedule from cron.job where jobname='plateform-daily-backup' and active order by jobid desc limit 1),
    'workers',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'worker',w.worker,
        'status',coalesce(h.status,'UNSEEN'),
        'last_seen_at',h.last_seen_at,
        'fresh',coalesce(h.last_seen_at>now()-w.max_age,false)
      ) order by w.worker),'[]'::jsonb)
      from (values
        ('BACKUP'::text,interval '5 minutes'),
        ('RETENTION'::text,interval '45 minutes'),
        ('RESTORE_TEST'::text,interval '5 minutes'),
        ('RESTORE'::text,interval '5 minutes')
      ) as w(worker,max_age)
      left join private.continuity_worker_heartbeats h on h.worker=w.worker
    )
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

select public.reconcile_all_continuity_alerts();
commit;