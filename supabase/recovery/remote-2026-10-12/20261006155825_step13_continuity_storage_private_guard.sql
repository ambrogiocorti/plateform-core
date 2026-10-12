
update storage.buckets
set public=false
where (id like 'continuity-%' or id like 'plateform-continuity-%')
  and public;

create or replace function private.enforce_continuity_bucket_private()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if (new.id like 'continuity-%' or new.id like 'plateform-continuity-%')
     and new.public then
    raise exception 'CONTINUITY_BUCKET_MUST_BE_PRIVATE' using errcode='23514';
  end if;
  return new;
end
$$;

drop trigger if exists continuity_bucket_private_guard on storage.buckets;
create trigger continuity_bucket_private_guard
before insert or update of id,public
on storage.buckets
for each row
execute function private.enforce_continuity_bucket_private();

revoke all on function private.enforce_continuity_bucket_private()
from public,anon,authenticated;
