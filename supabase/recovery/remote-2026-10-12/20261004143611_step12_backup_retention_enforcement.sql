begin;

alter table public.backup_metadata
  add column if not exists artifacts_purged_at timestamptz,
  add column if not exists purge_attempts integer not null default 0,
  add column if not exists purge_lease_token uuid,
  add column if not exists purge_lease_expires_at timestamptz,
  add column if not exists purge_error_code text;

alter table public.backup_metadata drop constraint if exists backup_metadata_purge_attempts_check;
alter table public.backup_metadata add constraint backup_metadata_purge_attempts_check
  check (purge_attempts between 0 and 100);

create index if not exists backup_metadata_retention_pending_idx
  on public.backup_metadata(retention_until,id)
  where status='SUCCEEDED' and artifacts_purged_at is null;

create or replace function public.claim_backup_retention_job(p_lease_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.backup_metadata;
  token uuid:=gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'INVALID_LEASE';
  end if;

  select b.* into job
  from public.backup_metadata b
  where b.status='SUCCEEDED'
    and b.retention_until is not null
    and b.retention_until<=now()
    and b.artifacts_purged_at is null
    and (b.purge_lease_expires_at is null or b.purge_lease_expires_at<now())
    and not exists (
      select 1 from public.restore_jobs r
      where r.status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
        and (r.backup_id=b.id or r.pre_restore_backup_id=b.id)
    )
  order by b.retention_until,b.created_at,b.id
  for update skip locked
  limit 1;

  if job.id is null then return null; end if;

  update public.backup_metadata
  set purge_attempts=purge_attempts+1,
      purge_lease_token=token,
      purge_lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      purge_error_code=null,
      updated_at=now()
  where id=job.id
  returning * into job;

  return jsonb_build_object(
    'id',job.id,
    'database_reference',job.database_reference,
    'retention_until',job.retention_until,
    'lease_token',token,
    'attempt',job.purge_attempts
  );
end $$;

revoke all on function public.claim_backup_retention_job(integer) from public,anon,authenticated;
grant execute on function public.claim_backup_retention_job(integer) to service_role;

create or replace function public.finish_backup_retention_job(
  p_id uuid,p_lease uuid,p_success boolean,p_error_code text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare job public.backup_metadata;
begin
  select * into job from public.backup_metadata where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.artifacts_purged_at is not null then return; end if;
  if job.purge_lease_token is distinct from p_lease or job.purge_lease_expires_at<=now() then
    raise exception 'RETENTION_LEASE_LOST';
  end if;

  if p_success then
    update public.backup_metadata
    set artifacts_purged_at=now(),
        database_reference=null,
        auth_reference=null,
        storage_reference=null,
        purge_lease_token=null,
        purge_lease_expires_at=null,
        purge_error_code=null,
        updated_at=now()
    where id=job.id;

    perform private.audit(
      'BACKUP_ARTIFACTS_PURGED','backup_metadata',job.id,null,
      jsonb_build_object('retention_until',job.retention_until,'artifacts_purged_at',job.artifacts_purged_at),
      jsonb_build_object('retention_until',job.retention_until,'artifacts_purged_at',now())
    );
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then
      raise exception 'RETENTION_ERROR_CODE_REQUIRED';
    end if;
    update public.backup_metadata
    set purge_lease_token=null,
        purge_lease_expires_at=null,
        purge_error_code=trim(p_error_code),
        updated_at=now()
    where id=job.id;
    perform private.audit(
      'BACKUP_ARTIFACT_PURGE_FAILED','backup_metadata',job.id,null,
      jsonb_build_object('retention_until',job.retention_until),
      jsonb_build_object('error_code',trim(p_error_code)),
      'FAILURE'
    );
  end if;
end $$;

revoke all on function public.finish_backup_retention_job(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.finish_backup_retention_job(uuid,uuid,boolean,text) to service_role;

create or replace function private.reconcile_backup_retention_alert()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare condition_active boolean;
begin
  condition_active := exists (
    select 1 from public.backup_metadata b
    where b.status='SUCCEEDED'
      and b.retention_until<now()-interval '6 hours'
      and b.artifacts_purged_at is null
      and not exists (
        select 1 from public.restore_jobs r
        where r.status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
          and (r.backup_id=b.id or r.pre_restore_backup_id=b.id)
      )
  );

  return private.reconcile_continuity_incident(
    'CONTINUITY_RETENTION_OVERDUE',
    condition_active,
    'WARNING',
    'Retention backup non applicata',
    'Almeno un backup scaduto mantiene ancora gli artefatti oltre la finestra di tolleranza.',
    'Verificare il retention worker, il backup root e gli eventuali errori purge prima di aumentare la retention effettiva oltre il piano configurato.'
  );
end $$;

revoke all on function private.reconcile_backup_retention_alert() from public,anon,authenticated;
grant execute on function private.reconcile_backup_retention_alert() to service_role,postgres;

create or replace function public.reconcile_all_continuity_alerts()
returns jsonb
language sql
security invoker
set search_path=''
as $$
  select jsonb_build_object(
    'continuity',public.reconcile_continuity_alerts(),
    'cutover',private.reconcile_restore_cutover_alert(),
    'retention',private.reconcile_backup_retention_alert()
  )
$$;
revoke all on function public.reconcile_all_continuity_alerts() from public,anon,authenticated;
grant execute on function public.reconcile_all_continuity_alerts() to service_role,postgres;

commit;