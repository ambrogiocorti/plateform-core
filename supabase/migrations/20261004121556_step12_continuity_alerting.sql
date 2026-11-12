begin;
alter table public.incidents add column if not exists automation_key text;
alter table public.incidents drop constraint if exists incidents_automation_key_check;
alter table public.incidents add constraint incidents_automation_key_check check (automation_key is null or automation_key ~ '^CONTINUITY_[A-Z0-9_]{3,80}$');
create unique index if not exists one_open_automated_incident on public.incidents(automation_key) where automation_key is not null and status <> 'RESOLVED';

create or replace function private.reconcile_continuity_incident(
  p_key text,p_active boolean,p_severity public.incident_severity,p_title text,p_impact text,p_detail text
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare incident public.incidents; changed boolean := false;
begin
  if p_key is null or p_key !~ '^CONTINUITY_[A-Z0-9_]{3,80}$' or p_active is null or p_severity is null
     or length(trim(coalesce(p_title,''))) not between 3 and 160
     or length(trim(coalesce(p_impact,''))) not between 3 and 2000
     or length(trim(coalesce(p_detail,''))) not between 3 and 4000 then raise exception 'INVALID_CONTINUITY_ALERT'; end if;
  select * into incident from public.incidents where automation_key=p_key and status<>'RESOLVED' order by started_at desc,id desc for update limit 1;
  if p_active then
    if incident.id is null then
      insert into public.incidents(venue_id,component,severity,title,impact,status,owner_id,automation_key)
      values(null,'BACKUP',p_severity,trim(p_title),trim(p_impact),'OPEN',null,p_key) returning * into incident;
      insert into public.incident_events(incident_id,actor_id,action,detail) values(incident.id,null,'AUTO_OPEN',trim(p_detail));
      return jsonb_build_object('id',incident.id,'action','OPENED','status',incident.status);
    end if;
    changed := incident.severity is distinct from p_severity or incident.title is distinct from trim(p_title) or incident.impact is distinct from trim(p_impact);
    if changed then
      update public.incidents set severity=p_severity,title=trim(p_title),impact=trim(p_impact),status=case when status='MITIGATED' then 'INVESTIGATING' else status end
      where id=incident.id returning * into incident;
      insert into public.incident_events(incident_id,actor_id,action,detail) values(incident.id,null,'AUTO_UPDATED',trim(p_detail));
    end if;
    return jsonb_build_object('id',incident.id,'action',case when changed then 'UPDATED' else 'UNCHANGED' end,'status',incident.status);
  end if;
  if incident.id is not null then
    update public.incidents set status='RESOLVED',resolved_at=now(),postmortem='Condizione tecnica rientrata automaticamente. Verificare comunque la timeline prima di archiviare il caso.'
    where id=incident.id returning * into incident;
    insert into public.incident_events(incident_id,actor_id,action,detail) values(incident.id,null,'AUTO_RESOLVED','La condizione che ha generato l’alert non è più presente.');
    return jsonb_build_object('id',incident.id,'action','RESOLVED','status',incident.status);
  end if;
  return jsonb_build_object('id',null,'action','NONE','status',null);
end $$;
revoke all on function private.reconcile_continuity_incident(text,boolean,public.incident_severity,text,text,text) from public,anon,authenticated;
grant execute on function private.reconcile_continuity_incident(text,boolean,public.incident_severity,text,text,text) to service_role,postgres;

create or replace function public.reconcile_continuity_alerts()
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  latest_backup_failure timestamptz; latest_backup_success timestamptz;
  latest_restore_failure timestamptz; latest_restore_success timestamptz;
  results jsonb := '[]'::jsonb; condition_active boolean;
begin
  select max(completed_at) filter(where status='FAILED'),max(completed_at) filter(where status='SUCCEEDED' and integrity_verified)
    into latest_backup_failure,latest_backup_success from public.backup_metadata;
  select max(completed_at) filter(where status='FAILED'),max(completed_at) filter(where status='SUCCEEDED')
    into latest_restore_failure,latest_restore_success from public.restore_jobs;

  condition_active := not coalesce((select bool_or(j.active) from cron.job j where j.jobname='plateform-daily-backup'),false);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_CRON_INACTIVE',condition_active,'CRITICAL','Backup automatico non pianificato','Il job giornaliero di enqueue dei backup non risulta attivo.','Verificare pg_cron e ripristinare plateform-daily-backup prima della prossima finestra di backup.'));

  condition_active := latest_backup_success is null or latest_backup_success < now()-interval '36 hours';
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_VERIFIED_BACKUP_MISSING',condition_active,'WARNING','Backup verificato non disponibile','Non esiste un backup completo e verificato nelle ultime 36 ore.','Controllare worker, credenziali, destinazione persistente, manifest e verifica database/Auth/Storage.'));

  condition_active := latest_backup_failure is not null and latest_backup_failure > now()-interval '24 hours' and (latest_backup_success is null or latest_backup_success < latest_backup_failure);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_FAILED',condition_active,'INCIDENT','Backup fallito senza recupero successivo','L’ultimo esito rilevante del backup è un fallimento e non risulta un backup verificato successivo.','Aprire il dettaglio backup, correggere la causa e ottenere un backup SUCCEEDED con integrità verificata.'));

  condition_active := exists(select 1 from public.backup_metadata where (status='QUEUED' and created_at<now()-interval '45 minutes') or (status='RUNNING' and lease_expires_at<now()-interval '15 minutes'));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_BACKUP_QUEUE_STUCK',condition_active,'DEGRADED','Coda backup bloccata','Almeno un job backup è in attesa troppo a lungo o ha un lease scaduto non recuperato.','Verificare il worker esterno e reclamare in sicurezza i job con lease scaduto.'));

  condition_active := latest_restore_failure is not null and latest_restore_failure > now()-interval '24 hours' and (latest_restore_success is null or latest_restore_success < latest_restore_failure);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_FAILED',condition_active,'CRITICAL','Restore o restore test fallito','Un restore recente è terminato con errore e non risulta un restore riuscito successivo.','Preservare gli artefatti, verificare target e manifest e seguire il runbook prima di un nuovo tentativo.'));

  condition_active := exists(select 1 from public.restore_jobs where (status='SNAPSHOTTING' and confirmed_at<now()-interval '60 minutes') or (status in ('RESTORING','VERIFYING') and lease_expires_at<now()-interval '15 minutes'));
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_STUCK',condition_active,'CRITICAL','Restore bloccato','Un restore confermato non sta avanzando entro la finestra operativa prevista.','Non forzare retry distruttivi: verificare snapshot pre-restore, lease worker e target prima di intervenire.'));

  condition_active := not exists(select 1 from public.backup_metadata where status='SUCCEEDED' and integrity_verified and last_restore_test_at is not null);
  results:=results||jsonb_build_array(private.reconcile_continuity_incident('CONTINUITY_RESTORE_TEST_MISSING',condition_active,'WARNING','Restore test verificato non disponibile','Nessun backup ha ancora superato un restore test isolato.','Eseguire un restore test su un progetto disposable separato e completare tutti i controlli post-restore.'));

  return jsonb_build_object('checked_at',now(),'active_count',(select count(*) from public.incidents where automation_key like 'CONTINUITY_%' and status<>'RESOLVED'),'results',results);
end $$;
revoke all on function public.reconcile_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_continuity_alerts() to service_role;

do $$ begin
  if exists(select 1 from cron.job where jobname='plateform-continuity-alerts') then perform cron.unschedule('plateform-continuity-alerts'); end if;
end $$;
select cron.schedule('plateform-continuity-alerts','*/10 * * * *',$cron$select public.reconcile_continuity_alerts();$cron$);
select public.reconcile_continuity_alerts();
commit;