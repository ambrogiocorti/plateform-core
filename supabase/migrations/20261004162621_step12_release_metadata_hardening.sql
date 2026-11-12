begin;

drop trigger if exists touch_version on public.application_releases;
drop trigger if exists touch_version on public.database_migrations_metadata;

create or replace function private.guard_backup_release_metadata()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare active_version text;
begin
  if new.status='SUCCEEDED' then
    select version into active_version
    from public.application_releases
    where status in ('RELEASED','STAGING')
    order by released_at desc,id desc
    limit 1;

    if active_version is null then
      raise exception 'BACKUP_RELEASE_METADATA_REQUIRED';
    end if;

    new.release_version:=active_version;
  end if;
  return new;
end $$;

revoke all on function private.guard_backup_release_metadata() from public,anon,authenticated;

drop trigger if exists guard_backup_release_metadata on public.backup_metadata;
create trigger guard_backup_release_metadata
before insert or update of status,release_version,integrity_verified on public.backup_metadata
for each row execute function private.guard_backup_release_metadata();

commit;