begin;

create or replace function public.request_restore(p_backup uuid,p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  backup public.backup_metadata;
  ref uuid;
  prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_backup is null or p_key is null then raise exception 'INVALID_RESTORE_REQUEST'; end if;

  prior:=private.idempotency_begin(
    'request_restore',
    p_key,
    jsonb_build_object('backup_id',p_backup)
  );
  if prior is not null then return prior; end if;

  select * into backup from public.backup_metadata where id=p_backup for share;

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

  if exists(
    select 1 from public.restore_jobs
    where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
  ) then
    raise exception 'RESTORE_ALREADY_ACTIVE';
  end if;

  insert into public.restore_jobs(
    backup_id,requested_by,scope,status,mode,updated_at
  ) values(
    backup.id,actor,'INSTALLATION','REQUESTED','RESTORE',now()
  ) returning id into ref;

  perform private.audit(
    'RESTORE_REQUESTED','restore_jobs',ref,null,null,
    jsonb_build_object(
      'backup_id',backup.id,
      'backup_completed_at',backup.completed_at,
      'schema_version',backup.schema_version,
      'release_version',backup.release_version
    )
  );

  return private.idempotency_finish(
    'request_restore',
    p_key,
    jsonb_build_object(
      'id',ref,
      'status','REQUESTED',
      'backup_id',backup.id,
      'requires_step_up',true,
      'step_up_action','RESTORE'
    )
  );
end $$;

create or replace function public.request_restore_test(p_backup uuid,p_step_up uuid,p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  backup public.backup_metadata;
  ref uuid;
  prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_backup is null or p_step_up is null or p_key is null then
    raise exception 'INVALID_RESTORE_REQUEST';
  end if;

  prior:=private.idempotency_begin(
    'request_restore_test',
    p_key,
    jsonb_build_object('backup_id',p_backup)
  );
  if prior is not null then return prior; end if;

  select * into backup
    from public.backup_metadata
   where id=p_backup
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

  if exists(
    select 1 from public.restore_jobs
     where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
  ) then
    raise exception 'RESTORE_ALREADY_ACTIVE';
  end if;

  perform private.consume_step_up(p_step_up,'RESTORE',backup.id);

  insert into public.restore_jobs(
    backup_id,requested_by,scope,status,mode,reason,confirmed_at,updated_at
  ) values(
    backup.id,actor,'INSTALLATION','REQUESTED','TEST',
    'Isolated restore verification',now(),now()
  ) returning id into ref;

  perform private.audit(
    'RESTORE_TEST_REQUESTED','restore_jobs',ref,null,null,
    jsonb_build_object(
      'backup_id',backup.id,
      'backup_completed_at',backup.completed_at,
      'schema_version',backup.schema_version,
      'release_version',backup.release_version
    )
  );

  return private.idempotency_finish(
    'request_restore_test',
    p_key,
    jsonb_build_object('id',ref,'status','REQUESTED','mode','TEST','backup_id',backup.id)
  );
end $$;

commit;