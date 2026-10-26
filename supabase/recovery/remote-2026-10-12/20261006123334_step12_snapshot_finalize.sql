
create or replace function private.finalize_continuity_backup_snapshot(
  p_backup uuid,
  p_lease uuid,
  p_chunk_size integer default 200
) returns jsonb
language plpgsql
security definer
set search_path='pg_catalog','public','private','extensions'
as $$
declare
  b public.backup_metadata;
  k private.continuity_rehearsal_transfer_key;
  v_private_rows bigint;
  v_private_hash text;
  v_table_count integer;
  v_row_count bigint;
  v_auth_users bigint;
  v_storage_buckets bigint;
  v_storage_objects bigint;
  v_chunk integer;
  v_chunk_rows integer;
  v_chunk_count integer:=0;
  v_body text;
begin
  if p_chunk_size is null or p_chunk_size not between 50 and 500 then
    raise exception 'INVALID_CHUNK_SIZE';
  end if;

  select * into b
  from public.backup_metadata
  where id=p_backup
  for update;

  if b.id is null then raise exception 'NOT_FOUND'; end if;
  if b.status<>'RUNNING'
     or b.lease_token is distinct from p_lease
     or b.lease_expires_at is null
     or b.lease_expires_at<=clock_timestamp() then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  if not exists(
    select 1
    from private.continuity_rehearsal_snapshot_manifest
    where snapshot_id=p_backup and status='CAPTURING'
  ) then
    raise exception 'SNAPSHOT_NOT_CAPTURING';
  end if;

  select * into strict k
  from private.continuity_rehearsal_transfer_key
  where snapshot_id=p_backup;

  select
    coalesce(sum(row_count),0),
    encode(extensions.digest(
      coalesce(string_agg(
        table_name||':'||row_count::text||':'||data_sha256,
        '|' order by table_name
      ),''),
      'sha256'
    ),'hex')
  into v_private_rows,v_private_hash
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup
    and schema_name='private';

  select count(*)::integer,coalesce(sum(row_count),0)
  into v_table_count,v_row_count
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup;

  select coalesce(row_count,0)
  into v_auth_users
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup
    and schema_name='auth'
    and table_name='users';

  select coalesce(row_count,0)
  into v_storage_buckets
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup
    and schema_name='storage'
    and table_name='buckets';

  select coalesce(row_count,0)
  into v_storage_objects
  from private.continuity_rehearsal_snapshot_tables
  where snapshot_id=p_backup
    and schema_name='storage'
    and table_name='objects';

  update private.continuity_rehearsal_snapshot_manifest
  set auth_user_count=coalesce(v_auth_users,0),
      durable_private_row_count=v_private_rows,
      durable_private_sha256=v_private_hash,
      table_count=v_table_count,
      row_count=v_row_count,
      storage_bucket_count=coalesce(v_storage_buckets,0),
      storage_object_count=coalesce(v_storage_objects,0),
      status='FROZEN'
  where snapshot_id=p_backup;

  delete from private.continuity_rehearsal_transfer_chunks
  where snapshot_id=p_backup;

  if v_row_count>0 then
    for v_chunk in 0..ceil(v_row_count::numeric/p_chunk_size)::integer-1 loop
      select
        count(*)::integer,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'schema',schema_name,
              'table',table_name,
              'row_no',row_no,
              'data',row_data
            )
            order by schema_name,table_name,row_no
          )::text,
          '[]'
        )
      into v_chunk_rows,v_body
      from (
        select schema_name,table_name,row_no,row_data
        from private.continuity_rehearsal_snapshot_rows
        where snapshot_id=p_backup
        order by schema_name,table_name,row_no
        offset (v_chunk*p_chunk_size)
        limit p_chunk_size
      ) s;

      insert into private.continuity_rehearsal_transfer_chunks(
        snapshot_id,
        chunk_no,
        row_count,
        plaintext_sha256,
        ciphertext,
        created_at
      ) values(
        p_backup,
        v_chunk,
        v_chunk_rows,
        encode(extensions.digest(v_body,'sha256'),'hex'),
        extensions.pgp_sym_encrypt(
          v_body,
          k.encryption_key,
          'cipher-algo=aes256,compress-algo=2,compress-level=9'
        ),
        clock_timestamp()
      );
      v_chunk_count:=v_chunk_count+1;
    end loop;
  end if;

  return jsonb_build_object(
    'backup_id',p_backup,
    'status','FROZEN',
    'table_count',v_table_count,
    'row_count',v_row_count,
    'chunk_count',v_chunk_count,
    'auth_user_count',coalesce(v_auth_users,0),
    'durable_private_row_count',v_private_rows,
    'durable_private_sha256',v_private_hash,
    'storage_bucket_count',coalesce(v_storage_buckets,0),
    'storage_object_count',coalesce(v_storage_objects,0)
  );
end
$$;

revoke all on function private.finalize_continuity_backup_snapshot(uuid,uuid,integer)
from public,anon,authenticated;
