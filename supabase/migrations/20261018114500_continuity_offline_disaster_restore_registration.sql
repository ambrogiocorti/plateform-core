-- Step 12: register an OFFLINE disaster restore in the restored installation.
--
-- When the source installation is lost, no control plane is left to claim a
-- restore job. tools/disaster-restore rebuilds an EMPTY target from an encrypted
-- backup copy (primary or replica), verifies the HMAC manifest and the same gates
-- as finish_restore_job (plus managed overlay and security surface), then calls
-- this function on the restored database:
--   * the backup row restored from the dump is still RUNNING with its original
--     lease (the dump was taken mid-job): it is finalised through
--     finish_backup_job, so every existing durability/manifest guard applies;
--   * a RESTORE job is recorded as CUTOVER_REQUIRED for the declared Super Admin,
--     so going live still needs confirm_restore_cutover with step-up.
-- No data is modified other than these two control-plane rows and their audit.

insert into private.audit_event_catalog(
  action,category,severity,retention_class,label_it,requires_reason,requires_approval,implementation_status
)
select 'DISASTER_RESTORE_VERIFIED',category,severity,retention_class,
       'Ripristino da disastro verificato',false,false,implementation_status
  from private.audit_event_catalog where action='BACKUP_SUCCEEDED'
on conflict do nothing;

create or replace function public.record_disaster_restore(
  p_backup uuid,
  p_lease uuid,
  p_manifest jsonb,
  p_checksum text,
  p_backup_verification jsonb,
  p_size_bytes bigint,
  p_object_count bigint,
  p_encryption_key_id text,
  p_verification jsonb,
  p_target_reference text,
  p_operator uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.backup_metadata;
  existing public.restore_jobs;
  ref uuid;
  ok boolean;
begin
  if p_backup is null or p_operator is null or p_checksum !~ '^[0-9a-f]{64}$'
     or length(trim(coalesce(p_target_reference,''))) not between 1 and 2048
     or p_manifest is null or (p_manifest->>'backup_id') is distinct from p_backup::text then
    raise exception 'INVALID_DISASTER_RESTORE';
  end if;

  if not exists(
    select 1 from public.staff_profiles
     where id=p_operator and role='SUPER_ADMIN' and active
  ) then
    raise exception 'DISASTER_RESTORE_OPERATOR_INVALID';
  end if;

  ok := p_verification is not null and jsonb_typeof(p_verification)='object'
    and p_verification ?& array[
      'database','migrations','migration_count','migration_latest_version','migration_hash','auth',
      'private_state','storage','storage_metadata','storage_bucket_count','storage_object_count',
      'storage_metadata_hash','manifest','manifest_auth','rls','accounts','payments','audit',
      'sessions','devices','managed_overlay','security_surface'
    ]
    and p_verification->'database'='true'::jsonb
    and p_verification->'migrations'='true'::jsonb
    and (p_verification->>'migration_latest_version') ~ '^[0-9]{14}$'
    and (p_verification->>'migration_hash') ~ '^[0-9a-f]{64}$'
    and p_verification->'auth'='true'::jsonb
    and p_verification->'private_state'='true'::jsonb
    and p_verification->'storage'='true'::jsonb
    and p_verification->'storage_metadata'='true'::jsonb
    and p_verification->'manifest'='true'::jsonb
    and p_verification->'manifest_auth'='true'::jsonb
    and p_verification->'rls'='true'::jsonb
    and p_verification->'accounts'='true'::jsonb
    and p_verification->'payments'='true'::jsonb
    and p_verification->'audit'='true'::jsonb
    and p_verification->'sessions'='true'::jsonb
    and p_verification->'devices'='true'::jsonb
    and p_verification->'managed_overlay'='true'::jsonb
    and p_verification->'security_surface'='true'::jsonb;
  if ok is not true then raise exception 'RESTORE_VERIFICATION_REQUIRED'; end if;

  -- Idempotent re-run: the same restore was already recorded.
  select * into existing from public.restore_jobs
   where backup_id=p_backup and mode='RESTORE' and target_reference=trim(p_target_reference)
     and status in ('CUTOVER_REQUIRED','SUCCEEDED')
   order by created_at desc limit 1;
  if existing.id is not null then
    return jsonb_build_object('id',existing.id,'status',existing.status,'deduplicated',true);
  end if;

  select * into b from public.backup_metadata where id=p_backup for update;
  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status='RUNNING' and b.lease_token is not distinct from p_lease and p_lease is not null then
    perform public.finish_backup_job(
      p_backup,p_lease,true,
      'plateform-backup://'||p_backup::text||'/manifest.json#database',
      'plateform-backup://'||p_backup::text||'/manifest.json#auth',
      'plateform-backup://'||p_backup::text||'/manifest.json#storage',
      p_manifest,p_backup_verification||jsonb_build_object('reconciled_by','DISASTER_RESTORE'),
      p_checksum,p_size_bytes,p_object_count,p_encryption_key_id,null
    );
  elsif b.status<>'SUCCEEDED' or b.checksum is distinct from p_checksum then
    raise exception 'DISASTER_RESTORE_BACKUP_STATE_INVALID';
  end if;

  -- Insert as VERIFYING and transition, so the restore_jobs update guards
  -- (manifest auth, migration version, private state) evaluate the evidence.
  insert into public.restore_jobs(
    backup_id,requested_by,scope,status,mode,reason,confirmed_at,attempts,target_reference,updated_at
  ) values(
    p_backup,p_operator,'INSTALLATION','VERIFYING','RESTORE',
    'Offline disaster recovery from encrypted backup copy',clock_timestamp(),1,
    trim(p_target_reference),clock_timestamp()
  ) returning id into ref;

  update public.restore_jobs
     set status='CUTOVER_REQUIRED',verification=p_verification,verified_at=clock_timestamp(),
         updated_at=clock_timestamp()
   where id=ref;

  perform private.audit(
    'DISASTER_RESTORE_VERIFIED','restore_jobs',ref,null,null,
    jsonb_build_object(
      'backup_id',p_backup,'operator',p_operator,'target_reference',trim(p_target_reference),
      'manifest_checksum',p_checksum,'verification',p_verification
    )
  );

  return jsonb_build_object('id',ref,'status','CUTOVER_REQUIRED','backup_id',p_backup,'deduplicated',false);
end $$;

revoke all on function public.record_disaster_restore(uuid,uuid,jsonb,text,jsonb,bigint,bigint,text,jsonb,text,uuid)
  from public,anon,authenticated;
grant execute on function public.record_disaster_restore(uuid,uuid,jsonb,text,jsonb,bigint,bigint,text,jsonb,text,uuid)
  to service_role;
