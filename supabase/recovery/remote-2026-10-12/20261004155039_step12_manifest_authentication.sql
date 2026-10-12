begin;

create or replace function private.guard_backup_manifest_auth()
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
      and (new.manifest->>'format_version')='2'
      and jsonb_typeof(new.manifest->'manifest_auth')='object'
      and new.manifest->'manifest_auth'->>'algorithm'='HMAC-SHA256'
      and new.manifest->'manifest_auth'->>'file'='manifest.hmac'
      and jsonb_typeof(new.verification)='object'
      and new.verification->'manifest_auth'='true'::jsonb;
    if ok is not true then
      raise exception 'BACKUP_MANIFEST_AUTH_REQUIRED';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_backup_manifest_auth() from public,anon,authenticated;

drop trigger if exists guard_backup_manifest_auth on public.backup_metadata;
create trigger guard_backup_manifest_auth
before insert or update of status,manifest,verification,integrity_verified on public.backup_metadata
for each row execute function private.guard_backup_manifest_auth();

create or replace function private.guard_restore_manifest_auth()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.status in ('SUCCEEDED','CUTOVER_REQUIRED') then
    if jsonb_typeof(new.verification)<>'object'
       or new.verification->'manifest_auth' is distinct from 'true'::jsonb then
      raise exception 'RESTORE_MANIFEST_AUTH_REQUIRED';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_restore_manifest_auth() from public,anon,authenticated;

drop trigger if exists guard_restore_manifest_auth on public.restore_jobs;
create trigger guard_restore_manifest_auth
before update of status,verification on public.restore_jobs
for each row execute function private.guard_restore_manifest_auth();

commit;