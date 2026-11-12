
create or replace function public.request_restore_test(
  p_backup uuid,
  p_step_up uuid,
  p_key uuid
)
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
     or backup.retention_until<=now()
     or coalesce(backup.schema_version,'')<'20261004075252' then
    raise exception 'RESTORE_BACKUP_NOT_ELIGIBLE';
  end if;

  if exists(
    select 1 from public.restore_jobs
     where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING')
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

create or replace function public.claim_restore_test_job(p_lease_seconds integer default 900)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.restore_jobs;
  token uuid:=gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'INVALID_LEASE';
  end if;

  select *
    into job
    from public.restore_jobs
   where mode='TEST'
     and (
       status='REQUESTED'
       or (status in ('RESTORING','VERIFYING') and lease_expires_at<now())
     )
   order by
     case status when 'VERIFYING' then 0 when 'RESTORING' then 1 else 2 end,
     created_at,id
   for update skip locked
   limit 1;

  if job.id is null then return null; end if;

  if job.status='REQUESTED' then
    update public.restore_jobs
       set status='RESTORING',
           attempts=attempts+1,
           lease_token=token,
           lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
           error_code=null,
           updated_at=now()
     where id=job.id
     returning * into job;

    perform private.audit(
      'RESTORE_TEST_STARTED','restore_jobs',job.id,null,
      jsonb_build_object('status','REQUESTED'),
      jsonb_build_object('status','RESTORING','backup_id',job.backup_id,'attempt',job.attempts)
    );
  else
    update public.restore_jobs
       set attempts=attempts+1,
           lease_token=token,
           lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
           error_code=null,
           updated_at=now()
     where id=job.id
     returning * into job;
  end if;

  return jsonb_build_object(
    'id',job.id,
    'backup_id',job.backup_id,
    'mode',job.mode,
    'status',job.status,
    'lease_token',token,
    'attempt',job.attempts
  );
end $$;

revoke execute on function public.request_restore_test(uuid,uuid,uuid) from public,anon;
grant execute on function public.request_restore_test(uuid,uuid,uuid) to authenticated;

revoke execute on function public.claim_restore_test_job(integer) from public,anon,authenticated;
grant execute on function public.claim_restore_test_job(integer) to service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.request_restore_test(uuid,uuid,uuid)','authenticated')
on conflict do nothing;
