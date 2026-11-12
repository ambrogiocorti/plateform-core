
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
   where
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
   order by
     case r.status
       when 'VERIFYING' then 0
       when 'RESTORING' then 1
       else 2
     end,
     r.created_at,
     r.id
   for update skip locked
   limit 1;

  if job.id is null then
    -- A failed pre-restore snapshot must fail closed instead of leaving the restore
    -- permanently in SNAPSHOTTING.
    select r.*
      into job
      from public.restore_jobs r
     where r.status='SNAPSHOTTING'
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

create or replace function public.mark_restore_verifying(
  p_id uuid,
  p_lease uuid,
  p_target_reference text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.restore_jobs;
begin
  select * into job
    from public.restore_jobs
   where id=p_id
   for update;

  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'RESTORING' or job.lease_token is distinct from p_lease then
    raise exception 'RESTORE_LEASE_LOST';
  end if;
  if p_target_reference is null or length(trim(p_target_reference)) not between 1 and 2048 then
    raise exception 'INVALID_RESTORE_TARGET';
  end if;

  update public.restore_jobs
     set status='VERIFYING',
         target_reference=trim(p_target_reference),
         lease_expires_at=now()+interval '5 minutes',
         updated_at=now()
   where id=job.id
   returning * into job;

  perform private.audit(
    'RESTORE_VERIFYING','restore_jobs',job.id,null,
    jsonb_build_object('status','RESTORING'),
    jsonb_build_object('status','VERIFYING','target_reference',trim(p_target_reference))
  );

  return jsonb_build_object(
    'id',job.id,
    'status',job.status,
    'target_reference',job.target_reference,
    'lease_token',job.lease_token
  );
end $$;

create or replace function public.finish_restore_job(
  p_id uuid,
  p_lease uuid,
  p_success boolean,
  p_verification jsonb,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.restore_jobs;
  ok boolean;
begin
  select * into job
    from public.restore_jobs
   where id=p_id
   for update;

  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'VERIFYING' or job.lease_token is distinct from p_lease then
    raise exception 'RESTORE_LEASE_LOST';
  end if;

  if p_success then
    ok :=
      p_verification is not null
      and jsonb_typeof(p_verification)='object'
      and p_verification ?& array[
        'database','auth','storage','manifest','rls',
        'accounts','payments','audit','sessions','devices'
      ]
      and p_verification->'database'='true'::jsonb
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'manifest'='true'::jsonb
      and p_verification->'rls'='true'::jsonb
      and p_verification->'accounts'='true'::jsonb
      and p_verification->'payments'='true'::jsonb
      and p_verification->'audit'='true'::jsonb
      and p_verification->'sessions'='true'::jsonb
      and p_verification->'devices'='true'::jsonb;

    if not ok then raise exception 'RESTORE_VERIFICATION_REQUIRED'; end if;

    update public.restore_jobs
       set status='SUCCEEDED',
           verification=p_verification,
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           error_code=null,
           updated_at=now()
     where id=job.id;

    if job.mode='TEST' then
      update public.backup_metadata
         set last_restore_test_at=now(),
             updated_at=now()
       where id=job.backup_id;
    end if;

    perform private.audit(
      'RESTORE_SUCCEEDED','restore_jobs',job.id,null,
      jsonb_build_object('status','VERIFYING'),
      jsonb_build_object(
        'status','SUCCEEDED',
        'backup_id',job.backup_id,
        'mode',job.mode,
        'verification',p_verification
      )
    );
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then
      raise exception 'RESTORE_ERROR_CODE_REQUIRED';
    end if;

    update public.restore_jobs
       set status='FAILED',
           verification=coalesce(p_verification,'{}'::jsonb),
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           error_code=trim(p_error_code),
           updated_at=now()
     where id=job.id;

    perform private.audit(
      'RESTORE_FAILED','restore_jobs',job.id,null,
      jsonb_build_object('status','VERIFYING'),
      jsonb_build_object('status','FAILED','error_code',trim(p_error_code)),
      'FAILURE'
    );
  end if;
end $$;

revoke execute on function public.claim_restore_job(integer) from public,anon,authenticated;
revoke execute on function public.mark_restore_verifying(uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.finish_restore_job(uuid,uuid,boolean,jsonb,text) from public,anon,authenticated;
grant execute on function public.claim_restore_job(integer) to service_role;
grant execute on function public.mark_restore_verifying(uuid,uuid,text) to service_role;
grant execute on function public.finish_restore_job(uuid,uuid,boolean,jsonb,text) to service_role;
