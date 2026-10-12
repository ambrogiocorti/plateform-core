
create or replace function public.enqueue_backup_worker_probe()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  ref uuid;
begin
  perform pg_advisory_xact_lock(hashtext('plateform:backup-worker-probe'));

  if exists(
    select 1
    from public.backup_metadata
    where status in ('QUEUED','RUNNING')
  ) then
    raise exception 'BACKUP_ALREADY_ACTIVE';
  end if;

  insert into public.backup_metadata(
    status,scope,purpose,requested_by,retention_until,updated_at
  ) values(
    'QUEUED','INSTALLATION','RESTORE_TEST',null,
    now()+interval '1 day',now()
  )
  returning id into ref;

  perform private.audit(
    'BACKUP_WORKER_PROBE_ENQUEUED',
    'backup_metadata',
    ref,
    null,
    null,
    jsonb_build_object('purpose','RESTORE_TEST','request_origin','SYSTEM')
  );

  return jsonb_build_object(
    'id',ref,
    'status','QUEUED',
    'purpose','RESTORE_TEST'
  );
end
$$;

revoke all on function public.enqueue_backup_worker_probe()
from public,anon,authenticated;
grant execute on function public.enqueue_backup_worker_probe()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.enqueue_backup_worker_probe()','service_role')
on conflict do nothing;
