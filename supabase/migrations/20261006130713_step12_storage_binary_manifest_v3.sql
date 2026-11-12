
create or replace function public.build_continuity_backup_artifact_meta_v3(
  p_backup uuid,
  p_lease uuid,
  p_primary_reference text,
  p_replica_reference text,
  p_storage_object_count integer,
  p_storage_plain_bytes bigint,
  p_storage_aggregate_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private','extensions'
as $$
declare
  v_meta jsonb;
  v_manifest jsonb;
  k private.continuity_rehearsal_transfer_key;
  v_hmac_key text;
  v_hmac text;
begin
  if p_storage_object_count is null or p_storage_object_count<0
     or p_storage_plain_bytes is null or p_storage_plain_bytes<0
     or coalesce(p_storage_aggregate_sha256,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_STORAGE_BACKUP_SUMMARY';
  end if;

  v_meta:=public.build_continuity_backup_artifact_meta_v2(
    p_backup,p_lease,p_primary_reference,p_replica_reference
  );

  select * into strict k
  from private.continuity_rehearsal_transfer_key
  where snapshot_id=p_backup;

  v_manifest:=v_meta->'manifest';

  v_manifest:=jsonb_set(
    v_manifest,
    '{components,storage,data_backup}',
    jsonb_build_object(
      'object_count',p_storage_object_count,
      'plain_bytes',p_storage_plain_bytes,
      'aggregate_sha256',p_storage_aggregate_sha256,
      'manifest_file','storage-files.json',
      'encryption','AES-256-GCM',
      'key_derivation','SHA-256(replica-channel-token:backup-id:storage-v1)'
    ),
    true
  );

  v_manifest:=jsonb_set(
    v_manifest,
    '{manifest_auth}',
    (v_manifest->'manifest_auth')-'hmac_sha256',
    true
  );

  v_hmac_key:=encode(
    extensions.hmac(
      convert_to('plateform-manifest-v2','utf8'),
      convert_to(k.encryption_key,'utf8'),
      'sha256'
    ),
    'hex'
  );

  v_hmac:=encode(
    extensions.hmac(
      convert_to(v_manifest::text,'utf8'),
      convert_to(v_hmac_key,'utf8'),
      'sha256'
    ),
    'hex'
  );

  v_manifest:=jsonb_set(
    v_manifest,
    '{manifest_auth}',
    (v_manifest->'manifest_auth')||jsonb_build_object('hmac_sha256',v_hmac),
    true
  );

  return v_meta || jsonb_build_object(
    'manifest',v_manifest,
    'manifest_hmac',v_hmac
  );
end
$$;

revoke all on function public.build_continuity_backup_artifact_meta_v3(
  uuid,uuid,text,text,integer,bigint,text
) from public,anon,authenticated;

grant execute on function public.build_continuity_backup_artifact_meta_v3(
  uuid,uuid,text,text,integer,bigint,text
) to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values (
  'public.build_continuity_backup_artifact_meta_v3(uuid,uuid,text,text,integer,bigint,text)',
  'service_role'
)
on conflict do nothing;
