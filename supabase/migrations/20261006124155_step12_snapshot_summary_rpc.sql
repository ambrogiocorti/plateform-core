
create or replace function public.get_continuity_backup_snapshot_summary(
  p_backup uuid,
  p_lease uuid
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private','extensions'
as $$
declare
  b public.backup_metadata;
  m private.continuity_rehearsal_snapshot_manifest;
  v_database_hash text;
  v_private_table_count integer;
  v_auth_identity_count bigint;
  v_auth_identity_hash text;
  v_auth_mfa_count bigint;
  v_auth_mfa_hash text;
  v_auth_users_hash text;
  v_storage_hash text;
  v_chunk_count integer;
  v_cipher_bytes bigint;
begin
  select * into b from public.backup_metadata where id=p_backup;
  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  select * into strict m
  from private.continuity_rehearsal_snapshot_manifest
  where snapshot_id=p_backup and status='FROZEN';

  select encode(extensions.digest(
    coalesce(string_agg(
      schema_name||'.'||table_name||':'||row_count::text||':'||data_sha256,
      '|' order by schema_name,table_name
    ),''),
    'sha256'
  ),'hex')
  into v_database_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup;

  select count(*)::integer
  into v_private_table_count
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='private';

  select row_count,data_sha256
  into v_auth_identity_count,v_auth_identity_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='identities';

  select row_count,data_sha256
  into v_auth_mfa_count,v_auth_mfa_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='mfa_factors';

  select data_sha256
  into v_auth_users_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='users';

  select encode(extensions.digest(
    coalesce(string_agg(
      table_name||':'||row_count::text||':'||data_sha256,
      '|' order by table_name
    ),''),
    'sha256'
  ),'hex')
  into v_storage_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='storage';

  select count(*)::integer,coalesce(sum(octet_length(ciphertext)),0)
  into v_chunk_count,v_cipher_bytes
  from private.continuity_rehearsal_transfer_chunks
  where snapshot_id=p_backup;

  return jsonb_build_object(
    'backup_id',p_backup,
    'table_count',m.table_count,
    'row_count',m.row_count,
    'chunk_count',v_chunk_count,
    'cipher_bytes',v_cipher_bytes,
    'migration_count',m.migration_count,
    'migration_latest_version',m.migration_latest_version,
    'migration_aggregate_sha256',m.migration_aggregate_sha256,
    'database_aggregate_sha256',v_database_hash,
    'auth_user_count',m.auth_user_count,
    'auth_users_sha256',v_auth_users_hash,
    'auth_identity_count',coalesce(v_auth_identity_count,0),
    'auth_identities_sha256',v_auth_identity_hash,
    'auth_mfa_factor_count',coalesce(v_auth_mfa_count,0),
    'auth_mfa_sha256',v_auth_mfa_hash,
    'private_table_count',v_private_table_count,
    'private_row_count',m.durable_private_row_count,
    'private_aggregate_sha256',m.durable_private_sha256,
    'storage_bucket_count',m.storage_bucket_count,
    'storage_object_count',m.storage_object_count,
    'storage_metadata_sha256',v_storage_hash
  );
end
$$;

revoke all on function public.get_continuity_backup_snapshot_summary(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.get_continuity_backup_snapshot_summary(uuid,uuid)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.get_continuity_backup_snapshot_summary(uuid,uuid)','service_role')
on conflict do nothing;
