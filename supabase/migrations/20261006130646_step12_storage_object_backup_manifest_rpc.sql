
create or replace function public.list_continuity_storage_object_snapshot(
  p_backup uuid,
  p_lease uuid
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  b public.backup_metadata;
  v_items jsonb;
begin
  select * into b from public.backup_metadata where id=p_backup;
  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  if not exists(
    select 1 from private.continuity_rehearsal_snapshot_manifest
    where snapshot_id=p_backup and status='FROZEN'
  ) then
    raise exception 'SNAPSHOT_NOT_FROZEN';
  end if;

  select coalesce(
    jsonb_agg(row_data order by row_no),
    '[]'::jsonb
  )
  into v_items
  from private.continuity_rehearsal_snapshot_rows
  where snapshot_id=p_backup
    and schema_name='storage'
    and table_name='objects';

  return jsonb_build_object(
    'backup_id',p_backup,
    'count',jsonb_array_length(v_items),
    'items',v_items
  );
end
$$;

revoke all on function public.list_continuity_storage_object_snapshot(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.list_continuity_storage_object_snapshot(uuid,uuid)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.list_continuity_storage_object_snapshot(uuid,uuid)','service_role')
on conflict do nothing;
