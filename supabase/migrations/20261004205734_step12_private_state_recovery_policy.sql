begin;

create or replace function private.guard_backup_private_state()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare p jsonb; ok boolean;
begin
  if new.status='SUCCEEDED' then
    p:=new.manifest->'components'->'private_state';
    ok :=
      jsonb_typeof(p)='object'
      and p->>'policy'='durable-private-v1'
      and p->>'security_sanitization'='invalidate-runtime-security-state-v1'
      and (p->>'durable_table_count') ~ '^[1-9][0-9]*$'
      and (p->>'durable_row_count') ~ '^[0-9]+$'
      and (p->>'durable_aggregate_sha256') ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(new.verification)='object'
      and new.verification->'private_state'='true'::jsonb;
    if ok is not true then raise exception 'BACKUP_PRIVATE_STATE_REQUIRED'; end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_backup_private_state() from public,anon,authenticated;

drop trigger if exists guard_backup_private_state on public.backup_metadata;
create trigger guard_backup_private_state
before insert or update of status,manifest,verification,integrity_verified on public.backup_metadata
for each row execute function private.guard_backup_private_state();

create or replace function private.guard_restore_private_state()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare ok boolean;
begin
  if new.status in ('SUCCEEDED','CUTOVER_REQUIRED') then
    ok :=
      jsonb_typeof(new.verification)='object'
      and new.verification->'private_state'='true'::jsonb
      and (new.verification->>'private_durable_rows') ~ '^[0-9]+$'
      and (new.verification->>'private_durable_hash') ~ '^[0-9a-f]{64}$'
      and new.verification->'sessions'='true'::jsonb;
    if ok is not true then raise exception 'RESTORE_PRIVATE_STATE_REQUIRED'; end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_restore_private_state() from public,anon,authenticated;

drop trigger if exists guard_restore_private_state on public.restore_jobs;
create trigger guard_restore_private_state
before update of status,verification on public.restore_jobs
for each row execute function private.guard_restore_private_state();

commit;