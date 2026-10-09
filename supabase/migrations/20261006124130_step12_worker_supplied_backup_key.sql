
create or replace function private.begin_continuity_backup_snapshot(
  p_backup uuid,
  p_lease uuid,
  p_encryption_key text
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private','extensions'
as $$
declare
  b public.backup_metadata;
  v_migration_count integer;
  v_migration_latest text;
  v_migration_hash text;
begin
  if p_backup is null
     or p_lease is null
     or coalesce(p_encryption_key,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_BACKUP_SNAPSHOT_REQUEST';
  end if;

  select * into b
  from public.backup_metadata
  where id=p_backup
  for update;

  if b.id is null then raise exception 'NOT_FOUND'; end if;

  if b.status<>'RUNNING'
     or b.lease_token is distinct from p_lease
     or b.lease_expires_at is null
     or b.lease_expires_at<=clock_timestamp() then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  delete from private.continuity_rehearsal_transfer_chunks where snapshot_id=p_backup;
  delete from private.continuity_rehearsal_snapshot_rows where snapshot_id=p_backup;
  delete from private.continuity_rehearsal_snapshot_tables where snapshot_id=p_backup;
  delete from private.continuity_rehearsal_transfer_key where snapshot_id=p_backup;
  delete from private.continuity_rehearsal_snapshot_manifest where snapshot_id=p_backup;

  select
    count(*)::integer,
    max(version),
    encode(extensions.digest(
      coalesce(jsonb_agg(
        jsonb_build_object(
          'version',version,
          'name',name,
          'statements',statements
        )
        order by version
      )::text,'[]'),
      'sha256'
    ),'hex')
  into v_migration_count,v_migration_latest,v_migration_hash
  from supabase_migrations.schema_migrations;

  insert into private.continuity_rehearsal_snapshot_manifest(
    snapshot_id,created_at,migration_count,migration_latest_version,
    migration_aggregate_sha256,auth_user_count,durable_private_row_count,
    durable_private_sha256,table_count,row_count,storage_bucket_count,
    storage_object_count,status
  ) values(
    p_backup,clock_timestamp(),v_migration_count,v_migration_latest,
    v_migration_hash,0,0,repeat('0',64),0,0,0,0,'CAPTURING'
  );

  insert into private.continuity_rehearsal_transfer_key(
    snapshot_id,encryption_key,created_at
  ) values(
    p_backup,p_encryption_key,clock_timestamp()
  );

  return jsonb_build_object(
    'backup_id',p_backup,
    'status','CAPTURING',
    'migration_count',v_migration_count,
    'migration_latest_version',v_migration_latest,
    'migration_aggregate_sha256',v_migration_hash
  );
end
$$;

revoke all on function private.begin_continuity_backup_snapshot(uuid,uuid,text)
from public,anon,authenticated;

create or replace function public.prepare_continuity_backup_snapshot(
  p_backup uuid,
  p_lease uuid,
  p_chunk_size integer,
  p_encryption_key text
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  a jsonb;
  b jsonb;
  c jsonb;
  d jsonb;
begin
  a:=private.begin_continuity_backup_snapshot(p_backup,p_lease,p_encryption_key);
  b:=private.capture_public_continuity_snapshot(p_backup,p_lease);
  c:=private.capture_durable_continuity_snapshot(p_backup,p_lease);
  d:=private.finalize_continuity_backup_snapshot(p_backup,p_lease,p_chunk_size);
  return a||b||c||d;
end
$$;

revoke all on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)
from public,anon,authenticated;
grant execute on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)','service_role')
on conflict do nothing;
