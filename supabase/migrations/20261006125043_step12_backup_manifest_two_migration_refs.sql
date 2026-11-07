CREATE OR REPLACE FUNCTION public.build_continuity_backup_artifact_meta(p_backup uuid, p_lease uuid, p_primary_reference text, p_replica_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'extensions'
AS $function$
declare
  b public.backup_metadata;
  m private.continuity_rehearsal_snapshot_manifest;
  k private.continuity_rehearsal_transfer_key;
  cfg private.continuity_worker_runtime_config;
  v_manifest jsonb;
  v_hmac_key text;
  v_hmac text;
  v_database_hash text;
  v_cipher_hash text;
  v_cipher_bytes bigint;
  v_chunk_count integer;
  v_users_hash text;
  v_identities_hash text;
  v_mfa_hash text;
  v_identity_count bigint;
  v_mfa_count bigint;
  v_storage_hash text;
  v_private_table_count integer;
  v_envelope text;
begin
  if p_primary_reference is null or p_replica_reference is null
     or length(trim(p_primary_reference)) not between 1 and 2048
     or length(trim(p_replica_reference)) not between 1 and 2048 then
    raise exception 'INVALID_BACKUP_REFERENCES';
  end if;

  select * into b
  from public.backup_metadata
  where id=p_backup;

  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  select * into strict m
  from private.continuity_rehearsal_snapshot_manifest
  where snapshot_id=p_backup and status='FROZEN';

  select * into strict k
  from private.continuity_rehearsal_transfer_key
  where snapshot_id=p_backup;

  select * into strict cfg
  from private.continuity_worker_runtime_config
  where id;

  select
    encode(extensions.digest(
      coalesce(string_agg(
        schema_name||'.'||table_name||':'||row_count::text||':'||data_sha256,
        '|' order by schema_name,table_name
      ),''),
      'sha256'
    ),'hex')
  into v_database_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup;

  select
    count(*)::integer,
    coalesce(sum(octet_length(ciphertext)),0)::bigint,
    encode(extensions.digest(
      coalesce(string_agg(
        encode(extensions.digest(ciphertext,'sha256'),'hex'),
        '' order by chunk_no
      ),''),
      'sha256'
    ),'hex')
  into v_chunk_count,v_cipher_bytes,v_cipher_hash
  from private.continuity_rehearsal_transfer_chunks
  where snapshot_id=p_backup;

  select data_sha256
    into v_users_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='users';

  select row_count,data_sha256
    into v_identity_count,v_identities_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='identities';

  select row_count,data_sha256
    into v_mfa_count,v_mfa_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='auth' and table_name='mfa_factors';

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

  select count(*)::integer
    into v_private_table_count
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup and schema_name='private';

  v_hmac_key:=encode(
    extensions.hmac(
      convert_to('plateform-manifest-v2','utf8'),
      convert_to(k.encryption_key,'utf8'),
      'sha256'
    ),
    'hex'
  );

  v_manifest:=jsonb_build_object(
    'format_version','2',
    'snapshot_id',p_backup,
    'manifest_auth',jsonb_build_object(
      'algorithm','HMAC-SHA256',
      'file','manifest.hmac',
      'key_id','backup:'||p_backup::text,
      'scope','canonical-jsonb-without-hmac'
    ),
    'durability',jsonb_build_object(
      'replica_required',true,
      'primary_reference',trim(p_primary_reference),
      'replica_reference',trim(p_replica_reference)
    ),
    'components',jsonb_build_object(
      'database',jsonb_build_object(
        'table_count',m.table_count,
        'row_count',m.row_count,
        'aggregate_sha256',v_database_hash,
        'cipher_sha256',v_cipher_hash,
        'cipher_bytes',v_cipher_bytes,
        'chunk_count',v_chunk_count
      ),
      'migrations',jsonb_build_object(
        'count',m.migration_count,
        'latest_version',m.migration_latest_version,
        'aggregate_sha256',m.migration_aggregate_sha256,
        'files',jsonb_build_array(
          jsonb_build_object(
            'file','artifact/migrations.sql',
            'kind','migration-bundle'
          ),
          jsonb_build_object(
            'file','supabase_migrations.schema_migrations',
            'kind','database-history'
          )
        )
      ),
      'auth',jsonb_build_object(
        'user_count',m.auth_user_count,
        'identity_count',coalesce(v_identity_count,0),
        'mfa_factor_count',coalesce(v_mfa_count,0),
        'users_sha256',v_users_hash,
        'identities_sha256',v_identities_hash,
        'mfa_sha256',v_mfa_hash
      ),
      'storage',jsonb_build_object(
        'metadata_fingerprint',jsonb_build_object(
          'bucket_count',m.storage_bucket_count,
          'object_count',m.storage_object_count,
          'aggregate_sha256',v_storage_hash
        )
      ),
      'private_state',jsonb_build_object(
        'policy','durable-private-v1',
        'security_sanitization','invalidate-runtime-security-state-v1',
        'durable_table_count',v_private_table_count,
        'durable_row_count',m.durable_private_row_count,
        'durable_aggregate_sha256',m.durable_private_sha256
      )
    )
  );

  v_hmac:=encode(
    extensions.hmac(
      convert_to(v_manifest::text,'utf8'),
      convert_to(v_hmac_key,'utf8'),
      'sha256'
    ),
    'hex'
  );

  v_envelope:=replace(
    encode(
      extensions.pgp_sym_encrypt(
        jsonb_build_object(
          'backup_id',p_backup,
          'backup_key',k.encryption_key,
          'manifest_hmac_key',v_hmac_key
        )::text,
        cfg.replica_channel_token,
        'cipher-algo=aes256,compress-algo=2,compress-level=9'
      ),
      'base64'
    ),
    E'\n',''
  );

  return jsonb_build_object(
    'backup_id',p_backup,
    'manifest',
      v_manifest ||
      jsonb_build_object(
        'manifest_auth',
        (v_manifest->'manifest_auth') ||
        jsonb_build_object('hmac_sha256',v_hmac)
      ),
    'manifest_hmac',v_hmac,
    'key_envelope_b64',v_envelope,
    'chunk_count',v_chunk_count,
    'cipher_bytes',v_cipher_bytes,
    'cipher_sha256',v_cipher_hash,
    'row_count',m.row_count,
    'table_count',m.table_count,
    'migration_count',m.migration_count,
    'migration_latest_version',m.migration_latest_version,
    'migration_aggregate_sha256',m.migration_aggregate_sha256,
    'private_durable_rows',m.durable_private_row_count,
    'private_durable_hash',m.durable_private_sha256,
    'storage_bucket_count',m.storage_bucket_count,
    'storage_object_count',m.storage_object_count,
    'storage_metadata_hash',v_storage_hash
  );
end
$function$
