begin;

create or replace function public.claim_backup_job(p_lease_seconds integer default 300)
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

  select *
    into job
    from public.backup_metadata
   where status='QUEUED'
      or (status='RUNNING' and lease_expires_at<now())
   order by
     case
       when status='RUNNING' then 0
       when purpose='PRE_RESTORE' then 1
       when purpose='RESTORE_TEST' then 2
       when purpose='MANUAL' then 3
       when purpose='SCHEDULED' then 4
       else 5
     end,
     created_at,id
   for update skip locked
   limit 1;

  if job.id is null then return null; end if;

  update public.backup_metadata
     set status='RUNNING',
         started_at=coalesce(started_at,now()),
         attempts=attempts+1,
         lease_token=token,
         lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
         error_code=null,
         updated_at=now()
   where id=job.id
   returning * into job;

  return jsonb_build_object(
    'id',job.id,
    'purpose',job.purpose,
    'scope',job.scope,
    'lease_token',token,
    'retention_until',job.retention_until,
    'attempt',job.attempts
  );
end $$;

create or replace function public.confirm_restore(p_restore uuid,p_step_up uuid,p_reason text,p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  job public.restore_jobs;
  backup public.backup_metadata;
  settings private.continuity_settings;
  snapshot_id uuid;
  prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_restore is null or p_step_up is null or p_key is null
     or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then
    raise exception 'INVALID_RESTORE_CONFIRMATION';
  end if;

  prior:=private.idempotency_begin(
    'confirm_restore',
    p_key,
    jsonb_build_object('restore_id',p_restore,'reason',trim(p_reason))
  );
  if prior is not null then return prior; end if;

  select * into job
    from public.restore_jobs
   where id=p_restore
   for update;

  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.mode<>'RESTORE' or job.status<>'REQUESTED' then
    raise exception 'RESTORE_STATE_INVALID';
  end if;

  select * into backup
    from public.backup_metadata
   where id=job.backup_id
   for share;

  if backup.id is null then raise exception 'NOT_FOUND'; end if;
  if backup.status<>'SUCCEEDED'
     or not backup.integrity_verified
     or not backup.includes_auth
     or not backup.includes_storage
     or backup.database_reference is null
     or backup.auth_reference is null
     or backup.storage_reference is null
     or backup.artifacts_purged_at is not null
     or backup.purge_attempts>0
     or backup.purge_lease_token is not null
     or backup.retention_until<=clock_timestamp()
     or coalesce(backup.schema_version,'')<'20261004075252' then
    raise exception 'RESTORE_BACKUP_NOT_ELIGIBLE';
  end if;

  select * into settings from private.continuity_settings where id;
  if settings.id is null then raise exception 'CONTINUITY_SETTINGS_REQUIRED'; end if;

  perform private.consume_step_up(p_step_up,'RESTORE',job.id);

  insert into public.backup_metadata(
    status,scope,purpose,requested_by,retention_until,updated_at
  ) values(
    'QUEUED','INSTALLATION','PRE_RESTORE',actor,
    now()+make_interval(days=>settings.backup_retention_days),now()
  ) returning id into snapshot_id;

  update public.restore_jobs
     set status='SNAPSHOTTING',
         pre_restore_backup_id=snapshot_id,
         reason=trim(p_reason),
         confirmed_at=now(),
         updated_at=now()
   where id=job.id;

  perform private.audit(
    'RESTORE_CONFIRMED','restore_jobs',job.id,null,
    jsonb_build_object('status','REQUESTED'),
    jsonb_build_object(
      'status','SNAPSHOTTING',
      'backup_id',job.backup_id,
      'pre_restore_backup_id',snapshot_id,
      'reason',trim(p_reason),
      'snapshot_retention_days',settings.backup_retention_days
    )
  );

  return private.idempotency_finish(
    'confirm_restore',
    p_key,
    jsonb_build_object(
      'id',job.id,
      'status','SNAPSHOTTING',
      'pre_restore_backup_id',snapshot_id
    )
  );
end $$;

commit;