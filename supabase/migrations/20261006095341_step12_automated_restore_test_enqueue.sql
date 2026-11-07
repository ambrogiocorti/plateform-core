
begin;

alter table public.restore_jobs
  alter column requested_by drop not null;

alter table public.restore_jobs
  drop constraint if exists restore_jobs_request_actor_guard;

alter table public.restore_jobs
  add constraint restore_jobs_request_actor_guard
  check (mode='TEST' or requested_by is not null);

create or replace function public.enqueue_restore_test_job(p_backup uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  b public.backup_metadata;
  ref uuid;
begin
  if p_backup is null then
    raise exception 'INVALID_RESTORE_REQUEST';
  end if;

  select *
    into b
    from public.backup_metadata
   where id=p_backup
   for share;

  if b.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if b.status<>'SUCCEEDED'
     or not b.integrity_verified
     or not b.includes_auth
     or not b.includes_storage
     or b.database_reference is null
     or b.auth_reference is null
     or b.storage_reference is null
     or b.artifacts_purged_at is not null
     or b.purge_attempts>0
     or b.purge_lease_token is not null
     or b.retention_until<=clock_timestamp()
     or coalesce(b.schema_version,'')<'20261004075252' then
    raise exception 'RESTORE_BACKUP_NOT_ELIGIBLE';
  end if;

  if exists(
    select 1
      from public.restore_jobs
     where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
  ) then
    raise exception 'RESTORE_ALREADY_ACTIVE';
  end if;

  insert into public.restore_jobs(
    backup_id,requested_by,scope,status,mode,reason,confirmed_at,updated_at
  ) values(
    b.id,null,'INSTALLATION','REQUESTED','TEST',
    'Automated isolated restore verification',clock_timestamp(),clock_timestamp()
  )
  returning id into ref;

  perform private.audit(
    'RESTORE_TEST_ENQUEUED','restore_jobs',ref,null,null,
    jsonb_build_object(
      'backup_id',b.id,
      'backup_completed_at',b.completed_at,
      'schema_version',b.schema_version,
      'release_version',b.release_version,
      'request_origin','SYSTEM'
    )
  );

  return jsonb_build_object(
    'id',ref,
    'status','REQUESTED',
    'mode','TEST',
    'backup_id',b.id,
    'requested_by',null,
    'request_origin','SYSTEM'
  );
end
$$;

revoke all on function public.enqueue_restore_test_job(uuid) from public,anon,authenticated;
grant execute on function public.enqueue_restore_test_job(uuid) to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.enqueue_restore_test_job(uuid)','service_role')
on conflict do nothing;

notify pgrst,'reload schema';
commit;
