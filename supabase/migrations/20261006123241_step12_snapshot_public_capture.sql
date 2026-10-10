
create or replace function private.capture_public_continuity_snapshot(
  p_backup uuid,
  p_lease uuid
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private'
as $$
declare
  b public.backup_metadata;
  r record;
  v_tables integer:=0;
  v_rows bigint:=0;
  v_result jsonb;
begin
  select * into b
  from public.backup_metadata
  where id=p_backup;

  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING' or b.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  for r in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relkind in ('r','p')
      and not c.relispartition
    order by c.relname
  loop
    v_result:=private.capture_continuity_snapshot_table(
      p_backup,'public',r.table_name,null
    );
    v_tables:=v_tables+1;
    v_rows:=v_rows+coalesce((v_result->>'row_count')::bigint,0);
  end loop;

  return jsonb_build_object(
    'backup_id',p_backup,
    'public_tables',v_tables,
    'public_rows',v_rows
  );
end
$$;

revoke all on function private.capture_public_continuity_snapshot(uuid,uuid)
from public,anon,authenticated;
