
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
  v_migrations jsonb;
  v_final jsonb;
begin
  v_begin:=private.begin_continuity_backup_snapshot(p_backup,p_lease);
  v_public:=private.capture_public_continuity_snapshot(p_backup,p_lease);
  v_durable:=private.capture_durable_continuity_snapshot(p_backup,p_lease);
  v_migrations:=private.capture_migration_history_snapshot(p_backup,p_lease);
  v_final:=private.finalize_continuity_backup_snapshot(p_backup,p_lease,p_chunk_size);

  return jsonb_build_object(
    'begin',v_begin,
    'public',v_public,
    'durable',v_durable,
    'migrations',v_migrations,
    'final',v_final
  );
end
$$;

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
  e jsonb;
begin
  a:=private.begin_continuity_backup_snapshot(p_backup,p_lease,p_encryption_key);
  b:=private.capture_public_continuity_snapshot(p_backup,p_lease);
  c:=private.capture_durable_continuity_snapshot(p_backup,p_lease);
  d:=private.capture_migration_history_snapshot(p_backup,p_lease);
  e:=private.finalize_continuity_backup_snapshot(p_backup,p_lease,p_chunk_size);
  return a||b||c||d||e;
end
$$;

revoke all on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
from public,anon,authenticated;
revoke all on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)
from public,anon,authenticated;
grant execute on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer)
to service_role,postgres;
grant execute on function public.prepare_continuity_backup_snapshot(uuid,uuid,integer,text)
to service_role,postgres;
