begin;

alter table public.restore_jobs
  add column if not exists mode text not null default 'RESTORE',
  add column if not exists reason text,
  add column if not exists confirmed_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempts integer not null default 0,
  add column if not exists target_reference text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.restore_jobs
  add constraint restore_jobs_mode_check
  check (mode in ('RESTORE','TEST'));

alter table public.restore_jobs
  add constraint restore_jobs_attempts_check
  check (attempts >= 0 and attempts <= 100);

create unique index restore_jobs_one_active
  on public.restore_jobs ((1))
  where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING');

create index restore_jobs_status_created_idx
  on public.restore_jobs(status,created_at desc);

create or replace function public.get_restore_preview(
  p_backup uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  backup public.backup_metadata;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[],false);
  select * into backup from public.backup_metadata where id=p_backup;

  if backup.id is null then raise exception 'NOT_FOUND'; end if;

  return jsonb_build_object(
    'backup_id',backup.id,
    'eligible',
      backup.status='SUCCEEDED'
      and backup.integrity_verified
      and backup.includes_auth
      and backup.includes_storage
      and backup.database_reference is not null
      and backup.auth_reference is not null
      and backup.storage_reference is not null
      and backup.retention_until>now()
      and coalesce(backup.schema_version,'')>='20261004075252',
    'completed_at',backup.completed_at,
    'retention_until',backup.retention_until,
    'size_bytes',backup.size_bytes,
    'object_count',backup.object_count,
    'schema_version',backup.schema_version,
    'release_version',backup.release_version,
    'last_restore_test_at',backup.last_restore_test_at,
    'scope','INSTALLATION',
    'pre_restore_snapshot_required',true,
    'downtime_required',true,
    'impact',jsonb_build_array(
      'database',
      'authentication',
      'storage',
      'restaurant_configuration',
      'operational_data',
      'financial_data',
      'audit_history'
    )
  );
end $$;

revoke all on function public.get_restore_preview(uuid) from public,anon;
grant execute on function public.get_restore_preview(uuid) to authenticated;

create function public.request_restore(
  p_backup uuid,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  backup public.backup_metadata;
  ref uuid;
  prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_backup is null or p_key is null then raise exception 'INVALID_RESTORE_REQUEST'; end if;

  prior:=private.idempotency_begin(
    'request_restore',
    p_key,
    jsonb_build_object('backup_id',p_backup)
  );
  if prior is not null then return prior; end if;

  select * into backup from public.backup_metadata where id=p_backup for share;

  if backup.id is null then raise exception 'NOT_FOUND'; end if;
  if backup.status<>'SUCCEEDED'
     or not backup.integrity_verified
     or not backup.includes_auth
     or not backup.includes_storage
     or backup.database_reference is null
     or backup.auth_reference is null
     or backup.storage_reference is null
     or backup.retention_until<=now()
     or coalesce(backup.schema_version,'')<'20261004075252' then
    raise exception 'RESTORE_BACKUP_NOT_ELIGIBLE';
  end if;

  if exists(
    select 1 from public.restore_jobs
    where status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING')
  ) then
    raise exception 'RESTORE_ALREADY_ACTIVE';
  end if;

  insert into public.restore_jobs(
    backup_id,requested_by,scope,status,mode,updated_at
  ) values(
    backup.id,actor,'INSTALLATION','REQUESTED','RESTORE',now()
  ) returning id into ref;

  perform private.audit(
    'RESTORE_REQUESTED','restore_jobs',ref,null,null,
    jsonb_build_object(
      'backup_id',backup.id,
      'backup_completed_at',backup.completed_at,
      'schema_version',backup.schema_version,
      'release_version',backup.release_version
    )
  );

  return private.idempotency_finish(
    'request_restore',
    p_key,
    jsonb_build_object(
      'id',ref,
      'status','REQUESTED',
      'backup_id',backup.id,
      'requires_step_up',true,
      'step_up_action','RESTORE'
    )
  );
end $$;

revoke all on function public.request_restore(uuid,uuid) from public,anon;
grant execute on function public.request_restore(uuid,uuid) to authenticated;

create function public.confirm_restore(
  p_restore uuid,
  p_step_up uuid,
  p_reason text,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor uuid;
  job public.restore_jobs;
  backup public.backup_metadata;
  snapshot_id uuid;
  prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);

  if p_restore is null or p_step_up is null or p_key is null
     or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then
    raise exception 'INVALID_RESTORE_CONFIRMATION';
  end if;

  prior:=private.idempotency_begin(
    'confirm_restore',
    p_key,
    jsonb_build_object('restore_id',p_restore,'reason',trim(p_reason))
  );
  if prior is not null then return prior; end if;

  select * into job
    from public.restore_jobs
   where id=p_restore
   for update;

  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.mode<>'RESTORE' or job.status<>'REQUESTED' then
    raise exception 'RESTORE_STATE_INVALID';
  end if;

  select * into backup
    from public.backup_metadata
   where id=job.backup_id
   for share;

  if backup.status<>'SUCCEEDED'
     or not backup.integrity_verified
     or backup.retention_until<=now() then
    raise exception 'RESTORE_BACKUP_NOT_ELIGIBLE';
  end if;

  perform private.consume_step_up(p_step_up,'RESTORE',job.id);

  insert into public.backup_metadata(
    status,scope,purpose,requested_by,retention_until,updated_at
  ) values(
    'QUEUED','INSTALLATION','PRE_RESTORE',actor,now()+interval '30 days',now()
  ) returning id into snapshot_id;

  update public.restore_jobs
     set status='SNAPSHOTTING',
         pre_restore_backup_id=snapshot_id,
         reason=trim(p_reason),
         confirmed_at=now(),
         updated_at=now()
   where id=job.id;

  perform private.audit(
    'RESTORE_CONFIRMED','restore_jobs',job.id,null,
    jsonb_build_object('status','REQUESTED'),
    jsonb_build_object(
      'status','SNAPSHOTTING',
      'backup_id',job.backup_id,
      'pre_restore_backup_id',snapshot_id,
      'reason',trim(p_reason)
    )
  );

  return private.idempotency_finish(
    'confirm_restore',
    p_key,
    jsonb_build_object(
      'id',job.id,
      'status','SNAPSHOTTING',
      'pre_restore_backup_id',snapshot_id
    )
  );
end $$;

revoke all on function public.confirm_restore(uuid,uuid,text,uuid) from public,anon;
grant execute on function public.confirm_restore(uuid,uuid,text,uuid) to authenticated;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_restore_preview(uuid)','authenticated'),
  ('public.request_restore(uuid,uuid)','authenticated'),
  ('public.confirm_restore(uuid,uuid,text,uuid)','authenticated')
on conflict do nothing;

commit;