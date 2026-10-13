
create or replace function public.prepare_continuity_backup_snapshot(
  p_backup uuid,
  p_lease uuid,
  p_chunk_size integer default 200
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
  a:=private.begin_continuity_backup_snapshot(p_backup,p_lease);
  b:=private.capture_public_continuity_snapshot(p_backup,p_lease);
  c:=private.capture_durable_continuity_snapshot(p_backup,p_lease);
  d:=private.finalize_continuity_backup_snapshot(p_backup,p_lease,p_chunk_size);

  return a||b||c||d;
end
$$;

revoke all on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
from public,anon,authenticated;
grant execute on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.prepare_continuity_backup_snapshot(uuid,uuid,integer)','service_role')
on conflict do nothing;
