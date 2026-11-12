
create or replace function public.export_continuity_migration_bundle(
  p_backup uuid,
  p_lease uuid
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  b public.backup_metadata;
  m private.continuity_rehearsal_snapshot_manifest;
  v_items jsonb;
begin
  select * into b from public.backup_metadata where id=p_backup;
  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  select * into strict m
  from private.continuity_rehearsal_snapshot_manifest
  where snapshot_id=p_backup and status='FROZEN';

  select coalesce(jsonb_agg(row_data order by row_data->>'version'),'[]'::jsonb)
  into v_items
  from private.continuity_rehearsal_snapshot_rows
  where snapshot_id=p_backup
    and schema_name='supabase_migrations'
    and table_name='schema_migrations';

  if jsonb_array_length(v_items)<>m.migration_count then
    raise exception 'MIGRATION_BUNDLE_COUNT_MISMATCH';
  end if;

  return jsonb_build_object(
    'count',m.migration_count,
    'latest_version',m.migration_latest_version,
    'aggregate_sha256',m.migration_aggregate_sha256,
    'items',v_items
  );
end
$$;

revoke all on function public.export_continuity_migration_bundle(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.export_continuity_migration_bundle(uuid,uuid)
to service_role,postgres;

create or replace function public.build_continuity_backup_artifact_meta_v2(
  p_backup uuid,
  p_lease uuid,
  p_primary_reference text,
  p_replica_reference text
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
  v_meta:=public.build_continuity_backup_artifact_meta(
    p_backup,p_lease,p_primary_reference,p_replica_reference
  );

  select * into strict k
  from private.continuity_rehearsal_transfer_key
  where snapshot_id=p_backup;

  v_manifest:=v_meta->'manifest';

  v_manifest:=jsonb_set(
    v_manifest,
    '{components,migrations,files}',
    jsonb_build_array(
      jsonb_build_object('file','migrations.json','kind','migration-bundle'),
      jsonb_build_object('file','migration-history.sha256','kind','migration-integrity')
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

  return v_meta
    || jsonb_build_object(
      'manifest',v_manifest,
      'manifest_hmac',v_hmac
    );
end
$$;

revoke all on function public.build_continuity_backup_artifact_meta_v2(uuid,uuid,text,text)
from public,anon,authenticated;
grant execute on function public.build_continuity_backup_artifact_meta_v2(uuid,uuid,text,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.export_continuity_migration_bundle(uuid,uuid)','service_role'),
  ('public.build_continuity_backup_artifact_meta_v2(uuid,uuid,text,text)','service_role')
on conflict do nothing;
