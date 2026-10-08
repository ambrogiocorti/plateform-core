begin;

create or replace function public.finish_backup_job(
  p_id uuid,
  p_lease uuid,
  p_success boolean,
  p_database_reference text,
  p_auth_reference text,
  p_storage_reference text,
  p_manifest jsonb,
  p_verification jsonb,
  p_checksum text,
  p_size_bytes bigint,
  p_object_count bigint,
  p_encryption_key_id text,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.backup_metadata;
  schema_ref text;
  release_ref text;
  ok boolean;
begin
  select * into job from public.backup_metadata where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'RUNNING' or job.lease_token is distinct from p_lease then raise exception 'BACKUP_LEASE_LOST'; end if;

  select max(version) into schema_ref from public.database_migrations_metadata;
  select version into release_ref from public.application_releases order by released_at desc,id desc limit 1;

  if p_success then
    ok :=
      p_database_reference is not null and length(trim(p_database_reference)) between 1 and 2048
      and p_auth_reference is not null and length(trim(p_auth_reference)) between 1 and 2048
      and p_storage_reference is not null and length(trim(p_storage_reference)) between 1 and 2048
      and p_manifest is not null and jsonb_typeof(p_manifest)='object'
      and jsonb_typeof(p_manifest->'components')='object'
      and (p_manifest->'components') ?& array['database','migrations','auth','storage']
      and jsonb_typeof(p_manifest->'components'->'migrations')='object'
      and jsonb_typeof(p_manifest->'components'->'migrations'->'files')='array'
      and jsonb_array_length(p_manifest->'components'->'migrations'->'files')=2
      and (p_manifest->'components'->'migrations'->>'count') ~ '^[0-9]+$'
      and (p_manifest->'components'->'migrations'->>'aggregate_sha256') ~ '^[0-9a-f]{64}$'
      and p_verification is not null and jsonb_typeof(p_verification)='object'
      and p_verification->'database'='true'::jsonb
      and p_verification->'migrations'='true'::jsonb
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'manifest'='true'::jsonb
      and p_checksum ~ '^[0-9a-f]{64}$'
      and p_size_bytes is not null and p_size_bytes>=0
      and p_object_count is not null and p_object_count>=0
      and p_encryption_key_id is not null and length(trim(p_encryption_key_id)) between 1 and 160;

    if not ok then raise exception 'BACKUP_INTEGRITY_REQUIRED'; end if;

    update public.backup_metadata
       set status='SUCCEEDED',
           database_reference=p_database_reference,
           auth_reference=p_auth_reference,
           storage_reference=p_storage_reference,
           manifest=p_manifest,
           verification=p_verification,
           checksum=p_checksum,
           includes_auth=true,
           includes_storage=true,
           size_bytes=p_size_bytes,
           object_count=p_object_count,
           schema_version=schema_ref,
           release_version=release_ref,
           encryption_key_id=trim(p_encryption_key_id),
           integrity_verified=true,
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           error_code=null,
           updated_at=now()
     where id=job.id;

    perform private.audit(
      'BACKUP_SUCCEEDED','backup_metadata',job.id,null,null,
      jsonb_build_object(
        'purpose',job.purpose,
        'size_bytes',p_size_bytes,
        'object_count',p_object_count,
        'schema_version',schema_ref,
        'release_version',release_ref,
        'migration_count',(p_manifest->'components'->'migrations'->>'count')::bigint,
        'migration_hash',p_manifest->'components'->'migrations'->>'aggregate_sha256'
      )
    );
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then raise exception 'BACKUP_ERROR_CODE_REQUIRED'; end if;
    update public.backup_metadata
       set status='FAILED',
           verification=coalesce(p_verification,'{}'::jsonb),
           manifest=coalesce(p_manifest,'{}'::jsonb),
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           integrity_verified=false,
           error_code=trim(p_error_code),
           updated_at=now()
     where id=job.id;
    perform private.audit(
      'BACKUP_FAILED','backup_metadata',job.id,null,null,
      jsonb_build_object('purpose',job.purpose,'error_code',trim(p_error_code)),
      'FAILURE'
    );
  end if;
end $$;

create or replace function public.finish_restore_job(
  p_id uuid,p_lease uuid,p_success boolean,p_verification jsonb,p_error_code text default null
) returns void
language plpgsql security definer set search_path=''
as $$
declare job public.restore_jobs; ok boolean; next_status text;
begin
  select * into job from public.restore_jobs where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'VERIFYING' or job.lease_token is distinct from p_lease then raise exception 'RESTORE_LEASE_LOST'; end if;

  if p_success then
    ok := p_verification is not null
      and jsonb_typeof(p_verification)='object'
      and p_verification ?& array['database','migrations','migration_count','migration_hash','auth','storage','manifest','rls','accounts','payments','audit','sessions','devices']
      and p_verification->'database'='true'::jsonb
      and p_verification->'migrations'='true'::jsonb
      and (p_verification->>'migration_count') ~ '^[0-9]+$'
      and (p_verification->>'migration_hash') ~ '^[0-9a-f]{64}$'
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

    next_status:=case when job.mode='TEST' then 'SUCCEEDED' else 'CUTOVER_REQUIRED' end;
    update public.restore_jobs
       set status=next_status,
           verification=p_verification,
           verified_at=now(),
           completed_at=case when job.mode='TEST' then now() else null end,
           lease_token=null,
           lease_expires_at=null,
           error_code=null,
           updated_at=now()
     where id=job.id;

    if job.mode='TEST' then
      update public.backup_metadata set last_restore_test_at=now(),updated_at=now() where id=job.backup_id;
      perform private.audit(
        'RESTORE_SUCCEEDED','restore_jobs',job.id,null,
        jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','SUCCEEDED','backup_id',job.backup_id,'mode',job.mode,'verification',p_verification)
      );
    else
      perform private.audit(
        'RESTORE_VERIFIED','restore_jobs',job.id,null,
        jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','CUTOVER_REQUIRED','backup_id',job.backup_id,'target_reference',job.target_reference,'verification',p_verification)
      );
    end if;
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then raise exception 'RESTORE_ERROR_CODE_REQUIRED'; end if;
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

commit;