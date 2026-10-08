begin;

create or replace function public.claim_restore_job(p_lease_seconds integer default 300)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.restore_jobs;
  snapshot public.backup_metadata;
  token uuid:=gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'INVALID_LEASE';
  end if;

  select r.*
    into job
    from public.restore_jobs r
   where r.mode='RESTORE'
     and (
       (
         r.status='SNAPSHOTTING'
         and r.pre_restore_backup_id is not null
         and exists (
           select 1
             from public.backup_metadata b
            where b.id=r.pre_restore_backup_id
              and b.status='SUCCEEDED'
              and b.integrity_verified
              and b.includes_auth
              and b.includes_storage
         )
       )
       or (
         r.status in ('RESTORING','VERIFYING')
         and r.lease_expires_at<now()
       )
     )
   order by
     case r.status when 'VERIFYING' then 0 when 'RESTORING' then 1 else 2 end,
     r.created_at,r.id
   for update skip locked
   limit 1;

  if job.id is null then
    select r.*
      into job
      from public.restore_jobs r
     where r.mode='RESTORE'
       and r.status='SNAPSHOTTING'
       and r.pre_restore_backup_id is not null
       and exists (
         select 1 from public.backup_metadata b
          where b.id=r.pre_restore_backup_id and b.status='FAILED'
       )
     order by r.created_at,r.id
     for update skip locked
     limit 1;

    if job.id is not null then
      update public.restore_jobs
         set status='FAILED',
             error_code='PRE_RESTORE_BACKUP_FAILED',
             completed_at=now(),
             lease_token=null,
             lease_expires_at=null,
             updated_at=now()
       where id=job.id;
      perform private.audit(
        'RESTORE_FAILED','restore_jobs',job.id,null,
        jsonb_build_object('status','SNAPSHOTTING'),
        jsonb_build_object('status','FAILED','error_code','PRE_RESTORE_BACKUP_FAILED'),
        'FAILURE'
      );
    end if;
    return null;
  end if;

  if job.status='SNAPSHOTTING' then
    select * into snapshot
      from public.backup_metadata
     where id=job.pre_restore_backup_id
     for share;

    if snapshot.status<>'SUCCEEDED'
       or not snapshot.integrity_verified
       or not snapshot.includes_auth
       or not snapshot.includes_storage then
      raise exception 'PRE_RESTORE_BACKUP_NOT_READY';
    end if;

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
      'RESTORE_STARTED','restore_jobs',job.id,null,
      jsonb_build_object('status','SNAPSHOTTING'),
      jsonb_build_object(
        'status','RESTORING',
        'backup_id',job.backup_id,
        'pre_restore_backup_id',job.pre_restore_backup_id,
        'attempt',job.attempts
      )
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
    'pre_restore_backup_id',job.pre_restore_backup_id,
    'mode',job.mode,
    'status',job.status,
    'lease_token',token,
    'attempt',job.attempts
  );
end $$;

commit;