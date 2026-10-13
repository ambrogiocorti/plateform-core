
create or replace function public.export_continuity_backup_chunk(
  p_backup uuid,
  p_lease uuid,
  p_chunk_no integer
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  b public.backup_metadata;
  c private.continuity_rehearsal_transfer_chunks;
  m private.continuity_rehearsal_snapshot_manifest;
begin
  if p_chunk_no is null or p_chunk_no<0 then
    raise exception 'INVALID_CHUNK';
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

  select * into strict c
  from private.continuity_rehearsal_transfer_chunks
  where snapshot_id=p_backup and chunk_no=p_chunk_no;

  return jsonb_build_object(
    'backup_id',p_backup,
    'chunk_no',c.chunk_no,
    'row_count',c.row_count,
    'total_rows',m.row_count,
    'table_count',m.table_count,
    'plaintext_sha256',c.plaintext_sha256,
    'cipher_b64',replace(encode(c.ciphertext,'base64'),E'\n','')
  );
end
$$;

revoke all on function public.export_continuity_backup_chunk(uuid,uuid,integer)
from public,anon,authenticated;
grant execute on function public.export_continuity_backup_chunk(uuid,uuid,integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.export_continuity_backup_chunk(uuid,uuid,integer)','service_role')
on conflict do nothing;
