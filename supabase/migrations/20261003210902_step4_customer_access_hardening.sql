begin;

create function private.preserve_public_table_id() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.public_table_id is distinct from old.public_table_id then
    raise exception 'PUBLIC_TABLE_ID_IMMUTABLE' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function private.preserve_public_table_id() from public,anon,authenticated,service_role;

create trigger preserve_public_table_id
  before update of public_table_id on public.tables
  for each row execute function private.preserve_public_table_id();

alter table private.customer_access_codes
  add constraint customer_access_code_lifetime check(expires_at > created_at);
alter table private.customer_sessions
  add constraint customer_session_lifetime check(expires_at > created_at);

create index customer_session_account_active
  on private.customer_sessions(account_id,expires_at)
  where revoked_at is null;

create function public.purge_customer_access_backoff(p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  if p_limit is null or p_limit not between 1 and 5000 then raise exception 'INVALID_LIMIT'; end if;
  delete from private.customer_access_backoff
  where bucket in (
    select bucket
    from private.customer_access_backoff
    where last_attempt_at < clock_timestamp()-interval '1 day'
      and coalesce(blocked_until,'-infinity'::timestamptz) < clock_timestamp()
    order by last_attempt_at
    limit p_limit
  );
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function public.purge_customer_access_backoff(integer) from public,anon,authenticated,service_role;
grant execute on function public.purge_customer_access_backoff(integer) to service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.purge_customer_access_backoff(integer)','service_role')
on conflict do nothing;

commit;