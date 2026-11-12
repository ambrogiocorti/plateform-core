begin;

create or replace function private.guard_backup_replica_durability()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare ok boolean;
begin
  if new.status='SUCCEEDED' then
    ok :=
      new.integrity_verified is true
      and jsonb_typeof(new.manifest)='object'
      and jsonb_typeof(new.manifest->'durability')='object'
      and new.manifest->'durability'->'replica_required'='true'::jsonb
      and jsonb_typeof(new.verification)='object'
      and new.verification ?& array['replica','replica_file_count','replica_size_bytes','replica_hash']
      and new.verification->'replica'='true'::jsonb
      and (new.verification->>'replica_file_count') ~ '^[1-9][0-9]*$'
      and (new.verification->>'replica_size_bytes') ~ '^[1-9][0-9]*$'
      and (new.verification->>'replica_hash') ~ '^[0-9a-f]{64}$';
    if ok is not true then
      raise exception 'BACKUP_REPLICA_DURABILITY_REQUIRED';
    end if;
  end if;
  return new;
end $$;

revoke all on function private.guard_backup_replica_durability() from public,anon,authenticated;

drop trigger if exists guard_backup_replica_durability on public.backup_metadata;
create trigger guard_backup_replica_durability
before insert or update of status,manifest,verification,integrity_verified on public.backup_metadata
for each row execute function private.guard_backup_replica_durability();

commit;