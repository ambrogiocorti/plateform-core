begin;

create or replace function public.finish_backup_job(
  p_id uuid,p_lease uuid,p_success boolean,p_database_reference text,p_auth_reference text,p_storage_reference text,
  p_manifest jsonb,p_verification jsonb,p_checksum text,p_size_bytes bigint,p_object_count bigint,p_encryption_key_id text,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare job public.backup_metadata; schema_ref text; release_ref text; ok boolean;
begin
  select * into job from public.backup_metadata where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'RUNNING' or job.lease_token is distinct from p_lease then raise exception 'BACKUP_LEASE_LOST'; end if;

  select version into release_ref from public.application_releases order by released_at desc,id desc limit 1;

  if p_success then
    ok :=
      p_database_reference is not null and length(trim(p_database_reference)) between 1 and 2048
      and p_auth_reference is not null and length(trim(p_auth_reference)) between 1 and 2048
      and p_storage_reference is not null and length(trim(p_storage_reference)) between 1 and 2048
      and p_manifest is not null and jsonb_typeof(p_manifest)='object'
      and (p_manifest->>'format_version')='2'
      and jsonb_typeof(p_manifest->'manifest_auth')='object'
      and p_manifest->'manifest_auth'->>'algorithm'='HMAC-SHA256'
      and p_manifest->'manifest_auth'->>'file'='manifest.hmac'
      and jsonb_typeof(p_manifest->'durability')='object'
      and p_manifest->'durability'->'replica_required'='true'::jsonb
      and jsonb_typeof(p_manifest->'components')='object'
      and (p_manifest->'components') ?& array['database','migrations','auth','storage']
      and jsonb_typeof(p_manifest->'components'->'migrations')='object'
      and jsonb_typeof(p_manifest->'components'->'migrations'->'files')='array'
      and jsonb_array_length(p_manifest->'components'->'migrations'->'files')=2
      and (p_manifest->'components'->'migrations'->>'count') ~ '^[0-9]+$'
      and (p_manifest->'components'->'migrations'->>'latest_version') ~ '^[0-9]{14}$'
      and (p_manifest->'components'->'migrations'->>'aggregate_sha256') ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(p_manifest->'components'->'storage')='object'
      and jsonb_typeof(p_manifest->'components'->'storage'->'metadata_fingerprint')='object'
      and (p_manifest->'components'->'storage'->'metadata_fingerprint'->>'bucket_count') ~ '^[0-9]+$'
      and (p_manifest->'components'->'storage'->'metadata_fingerprint'->>'object_count') ~ '^[0-9]+$'
      and (p_manifest->'components'->'storage'->'metadata_fingerprint'->>'aggregate_sha256') ~ '^[0-9a-f]{64}$'
      and p_verification is not null and jsonb_typeof(p_verification)='object'
      and p_verification ?& array[
        'database','migrations','auth','storage','storage_metadata','replica','replica_file_count',
        'replica_size_bytes','replica_hash','manifest','manifest_auth'
      ]
      and p_verification->'database'='true'::jsonb
      and p_verification->'migrations'='true'::jsonb
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'storage_metadata'='true'::jsonb
      and p_verification->'replica'='true'::jsonb
      and (p_verification->>'replica_file_count') ~ '^[1-9][0-9]*$'
      and (p_verification->>'replica_size_bytes') ~ '^[1-9][0-9]*$'
      and (p_verification->>'replica_hash') ~ '^[0-9a-f]{64}$'
      and p_verification->'manifest'='true'::jsonb
      and p_verification->'manifest_auth'='true'::jsonb
      and p_checksum ~ '^[0-9a-f]{64}$'
      and p_size_bytes is not null and p_size_bytes>=0
      and p_object_count is not null and p_object_count>=0
      and p_encryption_key_id is not null and length(trim(p_encryption_key_id)) between 1 and 160;
    if ok is not true then raise exception 'BACKUP_INTEGRITY_REQUIRED'; end if;

    schema_ref:=p_manifest->'components'->'migrations'->>'latest_version';

    update public.backup_metadata
       set status='SUCCEEDED',database_reference=p_database_reference,auth_reference=p_auth_reference,
           storage_reference=p_storage_reference,manifest=p_manifest,verification=p_verification,checksum=p_checksum,
           includes_auth=true,includes_storage=true,size_bytes=p_size_bytes,object_count=p_object_count,
           schema_version=schema_ref,release_version=release_ref,encryption_key_id=trim(p_encryption_key_id),
           integrity_verified=true,completed_at=now(),lease_token=null,lease_expires_at=null,error_code=null,updated_at=now()
     where id=job.id;

    perform private.audit('BACKUP_SUCCEEDED','backup_metadata',job.id,null,null,jsonb_build_object(
      'purpose',job.purpose,'size_bytes',p_size_bytes,'object_count',p_object_count,'schema_version',schema_ref,
      'release_version',release_ref,'migration_count',(p_manifest->'components'->'migrations'->>'count')::bigint,
      'migration_hash',p_manifest->'components'->'migrations'->>'aggregate_sha256',
      'storage_bucket_count',(p_manifest->'components'->'storage'->'metadata_fingerprint'->>'bucket_count')::bigint,
      'storage_metadata_hash',p_manifest->'components'->'storage'->'metadata_fingerprint'->>'aggregate_sha256',
      'replica_hash',p_verification->>'replica_hash'
    ));
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then raise exception 'BACKUP_ERROR_CODE_REQUIRED'; end if;
    update public.backup_metadata
       set status='FAILED',verification=coalesce(p_verification,'{}'::jsonb),manifest=coalesce(p_manifest,'{}'::jsonb),
           completed_at=now(),lease_token=null,lease_expires_at=null,integrity_verified=false,error_code=trim(p_error_code),updated_at=now()
     where id=job.id;
    perform private.audit('BACKUP_FAILED','backup_metadata',job.id,null,null,jsonb_build_object('purpose',job.purpose,'error_code',trim(p_error_code)),'FAILURE');
  end if;
end $$;

create or replace function public.finish_restore_job(
  p_id uuid,p_lease uuid,p_success boolean,p_verification jsonb,p_error_code text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare job public.restore_jobs; ok boolean; next_status text;
begin
  select * into job from public.restore_jobs where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'VERIFYING' or job.lease_token is distinct from p_lease then raise exception 'RESTORE_LEASE_LOST'; end if;

  if p_success then
    ok := p_verification is not null
      and jsonb_typeof(p_verification)='object'
      and p_verification ?& array[
        'database','migrations','migration_count','migration_latest_version','migration_hash','auth','storage','storage_metadata',
        'storage_bucket_count','storage_object_count','storage_metadata_hash','manifest','manifest_auth',
        'rls','accounts','payments','audit','sessions','devices'
      ]
      and p_verification->'database'='true'::jsonb
      and p_verification->'migrations'='true'::jsonb
      and (p_verification->>'migration_count') ~ '^[0-9]+$'
      and (p_verification->>'migration_latest_version') ~ '^[0-9]{14}$'
      and (p_verification->>'migration_hash') ~ '^[0-9a-f]{64}$'
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'storage_metadata'='true'::jsonb
      and (p_verification->>'storage_bucket_count') ~ '^[0-9]+$'
      and (p_verification->>'storage_object_count') ~ '^[0-9]+$'
      and (p_verification->>'storage_metadata_hash') ~ '^[0-9a-f]{64}$'
      and p_verification->'manifest'='true'::jsonb
      and p_verification->'manifest_auth'='true'::jsonb
      and p_verification->'rls'='true'::jsonb
      and p_verification->'accounts'='true'::jsonb
      and p_verification->'payments'='true'::jsonb
      and p_verification->'audit'='true'::jsonb
      and p_verification->'sessions'='true'::jsonb
      and p_verification->'devices'='true'::jsonb;
    if ok is not true then raise exception 'RESTORE_VERIFICATION_REQUIRED'; end if;

    next_status:=case when job.mode='TEST' then 'SUCCEEDED' else 'CUTOVER_REQUIRED' end;
    update public.restore_jobs
       set status=next_status,verification=p_verification,verified_at=now(),
           completed_at=case when job.mode='TEST' then now() else null end,
           lease_token=null,lease_expires_at=null,error_code=null,updated_at=now()
     where id=job.id;

    if job.mode='TEST' then
      update public.backup_metadata set last_restore_test_at=now(),updated_at=now() where id=job.backup_id;
      perform private.audit('RESTORE_SUCCEEDED','restore_jobs',job.id,null,jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','SUCCEEDED','backup_id',job.backup_id,'mode',job.mode,'verification',p_verification));
    else
      perform private.audit('RESTORE_VERIFIED','restore_jobs',job.id,null,jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','CUTOVER_REQUIRED','backup_id',job.backup_id,'target_reference',job.target_reference,'verification',p_verification));
    end if;
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then raise exception 'RESTORE_ERROR_CODE_REQUIRED'; end if;
    update public.restore_jobs set status='FAILED',verification=coalesce(p_verification,'{}'::jsonb),completed_at=now(),
      lease_token=null,lease_expires_at=null,error_code=trim(p_error_code),updated_at=now() where id=job.id;
    perform private.audit('RESTORE_FAILED','restore_jobs',job.id,null,jsonb_build_object('status','VERIFYING'),
      jsonb_build_object('status','FAILED','error_code',trim(p_error_code)),'FAILURE');
  end if;
end $$;

create or replace function private.guard_backup_schema_snapshot()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare expected text;
begin
  if new.status='SUCCEEDED' then
    expected:=new.manifest->'components'->'migrations'->>'latest_version';
    if expected is null or expected !~ '^[0-9]{14}$' or new.schema_version is distinct from expected then
      raise exception 'BACKUP_SCHEMA_SNAPSHOT_MISMATCH';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_backup_schema_snapshot() from public,anon,authenticated;
drop trigger if exists guard_backup_schema_snapshot on public.backup_metadata;
create trigger guard_backup_schema_snapshot
before insert or update of status,manifest,schema_version on public.backup_metadata
for each row execute function private.guard_backup_schema_snapshot();

create or replace function private.guard_restore_migration_version()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status in ('SUCCEEDED','CUTOVER_REQUIRED') then
    if (new.verification->>'migration_latest_version') !~ '^[0-9]{14}$' then
      raise exception 'RESTORE_MIGRATION_VERSION_REQUIRED';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_restore_migration_version() from public,anon,authenticated;
drop trigger if exists guard_restore_migration_version on public.restore_jobs;
create trigger guard_restore_migration_version
before update of status,verification on public.restore_jobs
for each row execute function private.guard_restore_migration_version();

commit;