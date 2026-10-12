begin;

create table if not exists private.continuity_settings (
  id boolean primary key default true check(id),
  rpo_target_minutes integer not null default 60 check(rpo_target_minutes between 5 and 1440),
  rto_target_minutes integer not null default 60 check(rto_target_minutes between 15 and 1440),
  backup_retention_days integer not null default 30 check(backup_retention_days between 1 and 90),
  restore_test_interval_days integer not null default 30 check(restore_test_interval_days between 1 and 90),
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table private.continuity_settings enable row level security;
revoke all on private.continuity_settings from public,anon,authenticated;
insert into private.continuity_settings(id) values(true) on conflict(id) do nothing;

do $$ begin
  if not exists(select 1 from pg_trigger where tgrelid='private.continuity_settings'::regclass and tgname='touch_version') then
    create trigger touch_version before update on private.continuity_settings for each row execute function private.touch_version();
  end if;
end $$;

create or replace function public.configure_continuity_targets(
  p_version bigint,p_rpo_target_minutes integer,p_rto_target_minutes integer,
  p_backup_retention_days integer,p_restore_test_interval_days integer,p_key uuid
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare current_row private.continuity_settings; result jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then raise exception 'CHAIN_SCOPE_REQUIRED'; end if;
  if p_key is null or p_rpo_target_minutes not between 5 and 1440 or p_rto_target_minutes not between 15 and 1440
     or p_backup_retention_days not between 1 and 90 or p_restore_test_interval_days not between 1 and 90 then
    raise exception 'INVALID_CONTINUITY_TARGETS';
  end if;
  result:=private.idempotency_begin('continuity_targets',p_key,jsonb_build_object(
    'version',p_version,'rpo_target_minutes',p_rpo_target_minutes,'rto_target_minutes',p_rto_target_minutes,
    'backup_retention_days',p_backup_retention_days,'restore_test_interval_days',p_restore_test_interval_days));
  if result is not null then return result; end if;
  select * into current_row from private.continuity_settings where id for update;
  if current_row.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  update private.continuity_settings set rpo_target_minutes=p_rpo_target_minutes,rto_target_minutes=p_rto_target_minutes,
    backup_retention_days=p_backup_retention_days,restore_test_interval_days=p_restore_test_interval_days
  where id returning * into current_row;
  perform private.audit('CONTINUITY_TARGETS_CHANGED','continuity_settings',null,null,null,jsonb_build_object('version',current_row.version));
  return private.idempotency_finish('continuity_targets',p_key,jsonb_build_object(
    'version',current_row.version,'rpo_target_minutes',current_row.rpo_target_minutes,'rto_target_minutes',current_row.rto_target_minutes,
    'backup_retention_days',current_row.backup_retention_days,'restore_test_interval_days',current_row.restore_test_interval_days));
end $$;
revoke all on function public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid) from public,anon;
grant execute on function public.configure_continuity_targets(bigint,integer,integer,integer,integer,uuid) to authenticated;

create or replace function public.enqueue_due_backup()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare settings private.continuity_settings; existing public.backup_metadata; latest_success timestamptz; latest_request timestamptz; ref uuid;
begin
  perform pg_advisory_xact_lock(hashtext('plateform:scheduled-backup'));
  select * into settings from private.continuity_settings where id;
  if settings.id is null then raise exception 'CONTINUITY_SETTINGS_REQUIRED'; end if;
  select * into existing from public.backup_metadata where purpose='SCHEDULED' and status in ('QUEUED','RUNNING') order by created_at desc,id desc limit 1;
  if existing.id is not null then return jsonb_build_object('id',existing.id,'status',existing.status,'due',false,'reason','ACTIVE_JOB'); end if;
  select max(completed_at) into latest_success from public.backup_metadata where status='SUCCEEDED' and integrity_verified;
  if latest_success is not null and latest_success >= now()-make_interval(mins=>settings.rpo_target_minutes) then
    return jsonb_build_object('id',null,'status','CURRENT','due',false,'reason','WITHIN_RPO_TARGET');
  end if;
  select max(created_at) into latest_request from public.backup_metadata where purpose='SCHEDULED';
  if latest_request is not null and latest_request > now()-interval '15 minutes' then
    return jsonb_build_object('id',null,'status','COOLDOWN','due',false,'reason','RETRY_COOLDOWN');
  end if;
  insert into public.backup_metadata(status,scope,purpose,requested_by,retention_until,updated_at)
  values('QUEUED','INSTALLATION','SCHEDULED',null,now()+make_interval(days=>settings.backup_retention_days),now()) returning id into ref;
  perform private.audit('BACKUP_SCHEDULED','backup_metadata',ref,null,null,jsonb_build_object('status','QUEUED'));
  return jsonb_build_object('id',ref,'status','QUEUED','due',true,'reason','RPO_TARGET_DUE');
end $$;
revoke all on function public.enqueue_due_backup() from public,anon,authenticated;
grant execute on function public.enqueue_due_backup() to service_role;

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

  condition_active := latest_restore_failure is not null and latest_restore_failure > now()-interval '24 hours' and (latest_restore_success is null or latest_restore_success < latest_restore_failure);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_FAILED',condition_active,'CRITICAL','Restore o restore test fallito','Un restore recente è terminato con errore e non risulta un restore riuscito successivo.','Preservare gli artefatti, verificare target e manifest e seguire il runbook prima di un nuovo tentativo.'));

  condition_active := exists(select 1 from public.restore_jobs where status in ('SNAPSHOTTING','RESTORING','VERIFYING') and coalesce(confirmed_at,created_at)<now()-make_interval(mins=>settings.rto_target_minutes));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_STUCK',condition_active,'CRITICAL','Restore oltre target RTO',format('Un restore confermato non è terminato entro il target RTO di %s minuti.',settings.rto_target_minutes),'Non forzare retry distruttivi: verificare snapshot pre-restore, lease worker e target prima di intervenire.'));

  condition_active := not exists(select 1 from public.backup_metadata where status='SUCCEEDED' and integrity_verified and last_restore_test_at>=now()-make_interval(days=>settings.restore_test_interval_days));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_TEST_MISSING',condition_active,'WARNING','Restore test da verificare',format('Nessun backup ha superato un restore test isolato negli ultimi %s giorni.',settings.restore_test_interval_days),'Eseguire un restore test su un progetto disposable separato e completare tutti i controlli post-restore.'));

  condition_active := latest_test_duration_minutes is not null and latest_test_duration_minutes>settings.rto_target_minutes;
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RTO_TARGET_MISSED',condition_active,'DEGRADED','Restore test oltre target RTO',format('L’ultimo restore test ha richiesto %s minuti rispetto al target di %s minuti.',round(latest_test_duration_minutes,1),settings.rto_target_minutes),'Analizzare i tempi di restore e adeguare infrastruttura o target senza dichiarare SLA non verificati.'));

  return jsonb_build_object('checked_at',now(),'active_count',(select count(*) from public.incidents where automation_key like 'CONTINUITY_%' and status<>'RESOLVED'),'results',results);
end $$;
revoke all on function public.reconcile_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_continuity_alerts() to service_role;

create or replace function public.get_technical_workspace()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare result jsonb; metrics jsonb; backup_health jsonb; continuity jsonb;
begin
  result:=private.technical_workspace_base();
  select to_jsonb(c) into continuity from private.continuity_settings c where id;
  with recent as (
    select created_at,(properties->>'status')::integer status,
      case when properties->>'duration_ms' ~ '^[0-9]{1,5}$' and (properties->>'duration_ms')::integer<=60000 then (properties->>'duration_ms')::integer end duration_ms
    from public.telemetry_events where created_at>now()-interval '15 minutes' and event in ('HTTP_SUCCESS','HTTP_FAILURE') and properties->>'status' ~ '^[2-5][0-9]{2}$'
  ) select jsonb_build_object('requests',count(*),'failures',count(*) filter(where status>=500),
    'error_percent',round(100.0*count(*) filter(where status>=500)/nullif(count(*),0),2),
    'latency_p95_ms',round(percentile_cont(.95) within group(order by duration_ms)::numeric),'latest_at',max(created_at))
  into metrics from recent;

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
    'expiring_7d',(select count(*) from public.backup_metadata where status='SUCCEEDED' and retention_until between now() and now()+interval '7 days'),
    'latest_status',(select status from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_integrity_verified',(select integrity_verified from public.backup_metadata order by created_at desc,id desc limit 1),
    'latest_retention_until',(select retention_until from public.backup_metadata order by created_at desc,id desc limit 1),
    'restore_pending_count',(select count(*) from public.restore_jobs where status in ('REQUESTED','SNAPSHOTTING','RESTORING','VERIFYING')),
    'restore_failed_24h',(select count(*) from public.restore_jobs where status='FAILED' and completed_at>now()-interval '24 hours'),
    'latest_restore_status',(select status from public.restore_jobs order by created_at desc,id desc limit 1),
    'cron_active',coalesce((select bool_or(active) from cron.job where jobname='plateform-daily-backup'),false),
    'cron_schedule',(select schedule from cron.job where jobname='plateform-daily-backup' and active order by jobid desc limit 1)
  ) into backup_health;

  result:=jsonb_set(result,'{usage,recent_devices}',to_jsonb((select count(*) from public.registered_devices d left join private.device_heartbeats h on h.device_id=d.id where d.revoked_at is null and greatest(d.last_seen_at,h.last_seen_at)>now()-interval '5 minutes')));
  return result||jsonb_build_object('metrics',metrics,'backup_health',backup_health,'continuity_targets',continuity,
    'restores',coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc) from(select id,backup_id,pre_restore_backup_id,scope,status,mode,reason,created_at,confirmed_at,completed_at,error_code,target_reference,attempts from public.restore_jobs order by created_at desc,id desc limit 10)x),'[]'::jsonb));
end $$;

do $$ begin
  if exists(select 1 from cron.job where jobname='plateform-daily-backup') then perform cron.unschedule('plateform-daily-backup'); end if;
end $$;
select cron.schedule('plateform-daily-backup','*/5 * * * *',$cron$select public.enqueue_due_backup();$cron$);
select public.reconcile_continuity_alerts();
commit;