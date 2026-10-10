
create or replace function private.capture_continuity_snapshot_table(
  p_snapshot uuid,
  p_schema text,
  p_table text,
  p_filter text default null
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private','extensions'
as $$
declare
  v_insert_columns text[];
  v_generated_columns text[];
  v_identity boolean;
  v_rows bigint;
  v_hash text;
  v_sql text;
begin
  if p_snapshot is null
     or p_schema not in ('public','private','auth','storage')
     or p_table is null
     or p_table !~ '^[A-Za-z0-9_]+$' then
    raise exception 'INVALID_SNAPSHOT_TABLE';
  end if;

  if to_regclass(format('%I.%I',p_schema,p_table)) is null then
    raise exception 'SNAPSHOT_TABLE_NOT_FOUND';
  end if;

  if not exists(
    select 1
    from private.continuity_rehearsal_snapshot_manifest
    where snapshot_id=p_snapshot and status='CAPTURING'
  ) then
    raise exception 'SNAPSHOT_NOT_CAPTURING';
  end if;

  select
    coalesce(array_agg(c.column_name order by c.ordinal_position)
      filter(where c.is_generated='NEVER'),'{}'::text[]),
    coalesce(array_agg(c.column_name order by c.ordinal_position)
      filter(where c.is_generated<>'NEVER'),'{}'::text[]),
    coalesce(bool_or(c.is_identity='YES' and c.identity_generation='ALWAYS'),false)
  into v_insert_columns,v_generated_columns,v_identity
  from information_schema.columns c
  where c.table_schema=p_schema and c.table_name=p_table;

  delete from private.continuity_rehearsal_snapshot_rows
   where snapshot_id=p_snapshot and schema_name=p_schema and table_name=p_table;
  delete from private.continuity_rehearsal_snapshot_tables
   where snapshot_id=p_snapshot and schema_name=p_schema and table_name=p_table;

  v_sql:=format(
    'insert into private.continuity_rehearsal_snapshot_rows(snapshot_id,schema_name,table_name,row_no,row_data) '
    ||'select $1,%L,%L,row_number() over(order by to_jsonb(t)::text),to_jsonb(t) '
    ||'from %I.%I t%s',
    p_schema,p_table,p_schema,p_table,
    case when p_filter is null or btrim(p_filter)='' then '' else ' where '||p_filter end
  );
  execute v_sql using p_snapshot;

  select count(*),
         encode(extensions.digest(coalesce(string_agg(
           encode(extensions.digest(row_data::text,'sha256'),'hex'),
           '' order by encode(extensions.digest(row_data::text,'sha256'),'hex')
         ),''),'sha256'),'hex')
    into v_rows,v_hash
  from private.continuity_rehearsal_snapshot_rows
  where snapshot_id=p_snapshot and schema_name=p_schema and table_name=p_table;

  insert into private.continuity_rehearsal_snapshot_tables(
    snapshot_id,schema_name,table_name,row_count,data_sha256,
    insert_columns,has_identity_always,generated_columns
  ) values(
    p_snapshot,p_schema,p_table,v_rows,v_hash,
    v_insert_columns,v_identity,v_generated_columns
  );

  return jsonb_build_object(
    'schema',p_schema,
    'table',p_table,
    'row_count',v_rows,
    'data_sha256',v_hash
  );
end
$$;

revoke all on function private.capture_continuity_snapshot_table(uuid,text,text,text)
from public,anon,authenticated;
