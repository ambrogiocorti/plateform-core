begin;

alter table public.backup_metadata
  add column if not exists purpose text not null default 'MANUAL',
  add column if not exists requested_by uuid references public.staff_profiles(id),
  add column if not exists database_reference text,
  add column if not exists auth_reference text,
  add column if not exists manifest jsonb not null default '{}'::jsonb,
  add column if not exists verification jsonb not null default '{}'::jsonb,
  add column if not exists size_bytes bigint,
  add column if not exists object_count bigint,
  add column if not exists schema_version text,
  add column if not exists release_version text,
  add column if not exists encryption_key_id text,
  add column if not exists attempts integer not null default 0,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.backup_metadata
  add constraint backup_metadata_purpose_check
  check (purpose in ('MANUAL','SCHEDULED','PRE_RESTORE','RESTORE_TEST'));

alter table public.backup_metadata
  add constraint backup_metadata_size_check
  check (size_bytes is null or size_bytes >= 0);

alter table public.backup_metadata
  add constraint backup_metadata_object_count_check
  check (object_count is null or object_count >= 0);

alter table public.backup_metadata
  add constraint backup_metadata_attempts_check
  check (attempts >= 0 and attempts <= 100);

create unique index backup_metadata_one_running
  on public.backup_metadata ((1))
  where status='RUNNING';

create index backup_metadata_retention_idx
  on public.backup_metadata(retention_until)
  where status='SUCCEEDED';

create index backup_metadata_status_created_idx
  on public.backup_metadata(status,created_at desc);

create or replace function public.create_backup(
  p_purpose text,
  p_retention_days integer,
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  ref uuid;
  prior jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_purpose not in ('MANUAL','RESTORE_TEST')
     or p_retention_days is null
     or p_retention_days not between 1 and 90
     or p_key is null then
    raise exception 'INVALID_BACKUP_REQUEST';
  end if;

  prior:=private.idempotency_begin(
    'create_backup',
    p_key,
    jsonb_build_object('purpose',p_purpose,'retention_days',p_retention_days)
  );
  if prior is not null then return prior; end if;

  insert into public.backup_metadata(
    status,scope,purpose,requested_by,retention_until,updated_at
  ) values(
    'QUEUED','INSTALLATION',p_purpose,private.effective_user_id(),
    now()+make_interval(days=>p_retention_days),now()
  ) returning id into ref;

  perform private.audit(
    'BACKUP_REQUESTED','backup_metadata',ref,null,null,
    jsonb_build_object('purpose',p_purpose,'retention_days',p_retention_days)
  );

  return private.idempotency_finish(
    'create_backup',
    p_key,
    jsonb_build_object('id',ref,'status','QUEUED')
  );
end $$;

revoke all on function public.create_backup(text,integer,uuid) from public,anon;
grant execute on function public.create_backup(text,integer,uuid) to authenticated;

create function public.claim_backup_job(
  p_lease_seconds integer default 300
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.backup_metadata;
  token uuid:=gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 60 and 1800 then
    raise exception 'INVALID_LEASE';
  end if;

  select *
    into job
    from public.backup_metadata
   where status='QUEUED'
      or (status='RUNNING' and lease_expires_at<now())
   order by case when status='RUNNING' then 0 else 1 end,created_at,id
   for update skip locked
   limit 1;

  if job.id is null then return null; end if;

  update public.backup_metadata
     set status='RUNNING',
         started_at=coalesce(started_at,now()),
         attempts=attempts+1,
         lease_token=token,
         lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
         error_code=null,
         updated_at=now()
   where id=job.id
   returning * into job;

  return jsonb_build_object(
    'id',job.id,
    'purpose',job.purpose,
    'scope',job.scope,
    'lease_token',token,
    'retention_until',job.retention_until,
    'attempt',job.attempts
  );
end $$;

revoke all on function public.claim_backup_job(integer) from public,anon,authenticated;
grant execute on function public.claim_backup_job(integer) to service_role;

create function public.finish_backup_job(
  p_id uuid,
  p_lease uuid,
  p_success boolean,
  p_database_reference text,
  p_auth_reference text,
  p_storage_reference text,
  p_manifest jsonb,
  p_verification jsonb,
  p_checksum text,
  p_size_bytes bigint,
  p_object_count bigint,
  p_encryption_key_id text,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  job public.backup_metadata;
  schema_ref text;
  release_ref text;
  ok boolean;
begin
  select * into job
    from public.backup_metadata
   where id=p_id
   for update;

  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'RUNNING' or job.lease_token is distinct from p_lease then
    raise exception 'BACKUP_LEASE_LOST';
  end if;

  select max(version) into schema_ref from public.database_migrations_metadata;
  select version into release_ref
    from public.application_releases
   order by released_at desc,id desc
   limit 1;

  if p_success then
    ok :=
      p_database_reference is not null and length(trim(p_database_reference)) between 1 and 2048
      and p_auth_reference is not null and length(trim(p_auth_reference)) between 1 and 2048
      and p_storage_reference is not null and length(trim(p_storage_reference)) between 1 and 2048
      and p_manifest is not null and jsonb_typeof(p_manifest)='object'
      and jsonb_typeof(p_manifest->'components')='object'
      and (p_manifest->'components') ?& array['database','auth','storage']
      and p_verification is not null and jsonb_typeof(p_verification)='object'
      and p_verification->'database'='true'::jsonb
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'manifest'='true'::jsonb
      and p_checksum ~ '^[0-9a-f]{64}$'
      and p_size_bytes is not null and p_size_bytes>=0
      and p_object_count is not null and p_object_count>=0
      and p_encryption_key_id is not null and length(trim(p_encryption_key_id)) between 1 and 160;

    if not ok then raise exception 'BACKUP_INTEGRITY_REQUIRED'; end if;

    update public.backup_metadata
       set status='SUCCEEDED',
           database_reference=p_database_reference,
           auth_reference=p_auth_reference,
           storage_reference=p_storage_reference,
           manifest=p_manifest,
           verification=p_verification,
           checksum=p_checksum,
           includes_auth=true,
           includes_storage=true,
           size_bytes=p_size_bytes,
           object_count=p_object_count,
           schema_version=schema_ref,
           release_version=release_ref,
           encryption_key_id=trim(p_encryption_key_id),
           integrity_verified=true,
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           error_code=null,
           updated_at=now()
     where id=job.id;

    perform private.audit(
      'BACKUP_SUCCEEDED','backup_metadata',job.id,null,null,
      jsonb_build_object(
        'purpose',job.purpose,
        'size_bytes',p_size_bytes,
        'object_count',p_object_count,
        'schema_version',schema_ref,
        'release_version',release_ref
      )
    );
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then
      raise exception 'BACKUP_ERROR_CODE_REQUIRED';
    end if;

    update public.backup_metadata
       set status='FAILED',
           verification=coalesce(p_verification,'{}'::jsonb),
           manifest=coalesce(p_manifest,'{}'::jsonb),
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           integrity_verified=false,
           error_code=trim(p_error_code),
           updated_at=now()
     where id=job.id;

    perform private.audit(
      'BACKUP_FAILED','backup_metadata',job.id,null,null,
      jsonb_build_object('purpose',job.purpose,'error_code',trim(p_error_code)),
      'FAILURE'
    );
  end if;
end $$;

revoke all on function public.finish_backup_job(uuid,uuid,boolean,text,text,text,jsonb,jsonb,text,bigint,bigint,text,text)
  from public,anon,authenticated;
grant execute on function public.finish_backup_job(uuid,uuid,boolean,text,text,text,jsonb,jsonb,text,bigint,bigint,text,text)
  to service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.create_backup(text,integer,uuid)','authenticated'),
  ('public.claim_backup_job(integer)','service_role'),
  ('public.finish_backup_job(uuid,uuid,boolean,text,text,text,jsonb,jsonb,text,bigint,bigint,text,text)','service_role')
on conflict do nothing;

commit;