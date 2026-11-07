
create or replace function private.capture_durable_continuity_snapshot(
  p_backup uuid,
  p_lease uuid
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  b public.backup_metadata;
  t text;
  v_tables integer:=0;
  v_rows bigint:=0;
  v_result jsonb;
  v_private_tables text[]:=array[
    'staff_pins',
    'idempotency_keys',
    'customer_access_codes',
    'provider_events',
    'device_registration_secrets',
    'provider_operation_events',
    'customer_identity_retention',
    'api_permission_manifest',
    'staff_command_secret_fingerprints',
    'staff_access_change_reasons',
    'continuity_settings'
  ];
begin
  select * into b
  from public.backup_metadata
  where id=p_backup;

  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  foreach t in array v_private_tables loop
    if to_regclass(format('private.%I',t)) is not null then
      v_result:=private.capture_continuity_snapshot_table(
        p_backup,'private',t,null
      );
      v_tables:=v_tables+1;
      v_rows:=v_rows+coalesce((v_result->>'row_count')::bigint,0);
    end if;
  end loop;

  foreach t in array array[
    'users','identities','mfa_factors','schema_migrations'
  ]::text[] loop
    v_result:=private.capture_continuity_snapshot_table(
      p_backup,'auth',t,null
    );
    v_tables:=v_tables+1;
    v_rows:=v_rows+coalesce((v_result->>'row_count')::bigint,0);
  end loop;

  v_result:=private.capture_continuity_snapshot_table(
    p_backup,
    'storage',
    'buckets',
    'id not like ''continuity-%'' and id not like ''plateform-continuity-%'''
  );
  v_tables:=v_tables+1;
  v_rows:=v_rows+coalesce((v_result->>'row_count')::bigint,0);

  v_result:=private.capture_continuity_snapshot_table(
    p_backup,
    'storage',
    'objects',
    'bucket_id not like ''continuity-%'' and bucket_id not like ''plateform-continuity-%'''
  );
  v_tables:=v_tables+1;
  v_rows:=v_rows+coalesce((v_result->>'row_count')::bigint,0);

  return jsonb_build_object(
    'backup_id',p_backup,
    'durable_tables',v_tables,
    'durable_rows',v_rows
  );
end
$$;

revoke all on function private.capture_durable_continuity_snapshot(uuid,uuid)
from public,anon,authenticated;
