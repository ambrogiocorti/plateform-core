
drop trigger if exists application_releases_immutable
on public.application_releases;
create trigger application_releases_immutable
before update or delete on public.application_releases
for each row
execute function private.immutable_record();

drop trigger if exists application_releases_no_truncate
on public.application_releases;
create trigger application_releases_no_truncate
before truncate on public.application_releases
for each statement
execute function private.immutable_record();

create unique index if not exists application_releases_build_id_uidx
  on public.application_releases(build_id);

create unique index if not exists application_releases_version_commit_uidx
  on public.application_releases(version,git_commit);
