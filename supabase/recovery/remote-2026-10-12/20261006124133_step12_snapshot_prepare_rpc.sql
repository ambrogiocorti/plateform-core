
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
  v_begin jsonb;
  v_public jsonb;
  v_durable jsonb;
  v_final jsonb;
begin
  v_begin:=private.begin_continuity_backup_snapshot(p_backup,p_lease);
  v_public:=private.capture_public_continuity_snapshot(p_backup,p_lease);
  v_durable:=private.capture_durable_continuity_snapshot(p_backup,p_lease);
  v_final:=private.finalize_continuity_backup_snapshot(p_backup,p_lease,p_chunk_size);

  return jsonb_build_object(
    'begin',v_begin,
    'public',v_public,
    'durable',v_durable,
    'final',v_final
  );
end
$$;

revoke all on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
from public,anon,authenticated;
grant execute on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
to service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.prepare_continuity_backup_snapshot(uuid,uuid,integer)','service_role')
on conflict do nothing;
