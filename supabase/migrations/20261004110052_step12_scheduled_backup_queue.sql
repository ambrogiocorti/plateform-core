
create or replace function public.enqueue_scheduled_backup(p_retention_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  existing public.backup_metadata;
  ref uuid;
begin
  if p_retention_days is null or p_retention_days not between 1 and 90 then
    raise exception 'INVALID_BACKUP_REQUEST';
  end if;

  perform pg_advisory_xact_lock(hashtext('plateform:scheduled-backup'));

  select *
    into existing
    from public.backup_metadata
   where purpose='SCHEDULED'
     and created_at >= date_trunc('day',now())
     and created_at < date_trunc('day',now()) + interval '1 day'
   order by created_at desc,id desc
   limit 1;

  if existing.id is not null then
    return jsonb_build_object(
      'id',existing.id,
      'status',existing.status,
      'deduplicated',true
    );
  end if;

  insert into public.backup_metadata(
    status,scope,purpose,requested_by,retention_until,updated_at
  ) values(
    'QUEUED','INSTALLATION','SCHEDULED',null,
    now()+make_interval(days=>p_retention_days),now()
  ) returning id into ref;

  perform private.audit(
    'BACKUP_SCHEDULED','backup_metadata',ref,null,null,
    jsonb_build_object('retention_days',p_retention_days)
  );

  return jsonb_build_object('id',ref,'status','QUEUED','deduplicated',false);
end $$;

revoke execute on function public.enqueue_scheduled_backup(integer)
from public,anon,authenticated;
grant execute on function public.enqueue_scheduled_backup(integer)
to service_role;
