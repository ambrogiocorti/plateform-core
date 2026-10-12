begin;

alter table public.restore_jobs drop constraint if exists restore_jobs_status_check;
alter table public.restore_jobs add constraint restore_jobs_status_check
  check (status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED','SUCCEEDED','FAILED'));
alter table public.restore_jobs add column if not exists verified_at timestamptz;
alter table public.restore_jobs add column if not exists cutover_confirmed_at timestamptz;
alter table public.restore_jobs add column if not exists cutover_confirmed_by uuid references public.staff_profiles(id);
alter table public.restore_jobs add column if not exists cutover_note text;

create or replace function private.guard_single_active_restore()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
     and exists (
       select 1 from public.restore_jobs r
        where r.id is distinct from new.id
          and r.status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','CUTOVER_REQUIRED')
     ) then
    raise exception 'RESTORE_ALREADY_ACTIVE';
  end if;
  return new;
end $$;
revoke all on function private.guard_single_active_restore() from public,anon,authenticated;

drop trigger if exists guard_single_active_restore on public.restore_jobs;
create trigger guard_single_active_restore
before insert or update of status on public.restore_jobs
for each row execute function private.guard_single_active_restore();

create or replace function public.finish_restore_job(
  p_id uuid,p_lease uuid,p_success boolean,p_verification jsonb,p_error_code text default null
) returns void
language plpgsql security definer set search_path=''
as $$
declare job public.restore_jobs; ok boolean; next_status text;
begin
  select * into job from public.restore_jobs where id=p_id for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.status<>'VERIFYING' or job.lease_token is distinct from p_lease then raise exception 'RESTORE_LEASE_LOST'; end if;

  if p_success then
    ok := p_verification is not null
      and jsonb_typeof(p_verification)='object'
      and p_verification ?& array['database','auth','storage','manifest','rls','accounts','payments','audit','sessions','devices']
      and p_verification->'database'='true'::jsonb
      and p_verification->'auth'='true'::jsonb
      and p_verification->'storage'='true'::jsonb
      and p_verification->'manifest'='true'::jsonb
      and p_verification->'rls'='true'::jsonb
      and p_verification->'accounts'='true'::jsonb
      and p_verification->'payments'='true'::jsonb
      and p_verification->'audit'='true'::jsonb
      and p_verification->'sessions'='true'::jsonb
      and p_verification->'devices'='true'::jsonb;
    if not ok then raise exception 'RESTORE_VERIFICATION_REQUIRED'; end if;

    next_status:=case when job.mode='TEST' then 'SUCCEEDED' else 'CUTOVER_REQUIRED' end;
    update public.restore_jobs
       set status=next_status,
           verification=p_verification,
           verified_at=now(),
           completed_at=case when job.mode='TEST' then now() else null end,
           lease_token=null,
           lease_expires_at=null,
           error_code=null,
           updated_at=now()
     where id=job.id;

    if job.mode='TEST' then
      update public.backup_metadata set last_restore_test_at=now(),updated_at=now() where id=job.backup_id;
      perform private.audit(
        'RESTORE_SUCCEEDED','restore_jobs',job.id,null,
        jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','SUCCEEDED','backup_id',job.backup_id,'mode',job.mode,'verification',p_verification)
      );
    else
      perform private.audit(
        'RESTORE_VERIFIED','restore_jobs',job.id,null,
        jsonb_build_object('status','VERIFYING'),
        jsonb_build_object('status','CUTOVER_REQUIRED','backup_id',job.backup_id,'target_reference',job.target_reference,'verification',p_verification)
      );
    end if;
  else
    if p_error_code is null or length(trim(p_error_code)) not between 2 and 80 then raise exception 'RESTORE_ERROR_CODE_REQUIRED'; end if;
    update public.restore_jobs
       set status='FAILED',
           verification=coalesce(p_verification,'{}'::jsonb),
           completed_at=now(),
           lease_token=null,
           lease_expires_at=null,
           error_code=trim(p_error_code),
           updated_at=now()
     where id=job.id;
    perform private.audit(
      'RESTORE_FAILED','restore_jobs',job.id,null,
      jsonb_build_object('status','VERIFYING'),
      jsonb_build_object('status','FAILED','error_code',trim(p_error_code)),
      'FAILURE'
    );
  end if;
end $$;

create or replace function private.confirm_restore_cutover_impl(
  p_restore uuid,p_step_up uuid,p_target_reference text,p_note text,p_key uuid
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare actor uuid; job public.restore_jobs; prior jsonb;
begin
  actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_restore is null or p_step_up is null or p_key is null
     or length(trim(coalesce(p_target_reference,''))) not between 1 and 2048
     or length(trim(coalesce(p_note,''))) not between 10 and 1000 then
    raise exception 'INVALID_CUTOVER_CONFIRMATION';
  end if;
  prior:=private.idempotency_begin('confirm_restore_cutover',p_key,jsonb_build_object('restore_id',p_restore,'target_reference',trim(p_target_reference),'note',trim(p_note)));
  if prior is not null then return prior; end if;

  select * into job from public.restore_jobs where id=p_restore for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.mode<>'RESTORE' or job.status<>'CUTOVER_REQUIRED' then raise exception 'RESTORE_STATE_INVALID'; end if;
  if job.target_reference is distinct from trim(p_target_reference) then raise exception 'RESTORE_TARGET_MISMATCH'; end if;

  perform private.consume_step_up(p_step_up,'RESTORE',job.id);
  update public.restore_jobs
     set status='SUCCEEDED',
         cutover_confirmed_at=now(),
         cutover_confirmed_by=actor,
         cutover_note=trim(p_note),
         completed_at=now(),
         updated_at=now()
   where id=job.id;

  perform private.audit(
    'RESTORE_CUTOVER_CONFIRMED','restore_jobs',job.id,null,
    jsonb_build_object('status','CUTOVER_REQUIRED','target_reference',job.target_reference),
    jsonb_build_object('status','SUCCEEDED','target_reference',job.target_reference,'note',trim(p_note))
  );

  return private.idempotency_finish('confirm_restore_cutover',p_key,jsonb_build_object('id',job.id,'status','SUCCEEDED','target_reference',job.target_reference));
end $$;

create or replace function public.confirm_restore_cutover(
  p_restore uuid,p_step_up uuid,p_target_reference text,p_note text,p_key uuid
) returns jsonb
language sql security invoker set search_path=''
as $$
  select private.confirm_restore_cutover_impl(p_restore,p_step_up,p_target_reference,p_note,p_key)
$$;
revoke all on function public.confirm_restore_cutover(uuid,uuid,text,text,uuid) from public,anon;
grant execute on function private.confirm_restore_cutover_impl(uuid,uuid,text,text,uuid),public.confirm_restore_cutover(uuid,uuid,text,text,uuid) to authenticated;

create or replace function private.abort_restore_cutover_impl(
  p_restore uuid,p_step_up uuid,p_reason text,p_key uuid
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare job public.restore_jobs; prior jsonb;
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
  if p_restore is null or p_step_up is null or p_key is null
     or length(trim(coalesce(p_reason,''))) not between 10 and 1000 then
    raise exception 'INVALID_CUTOVER_ABORT';
  end if;
  prior:=private.idempotency_begin('abort_restore_cutover',p_key,jsonb_build_object('restore_id',p_restore,'reason',trim(p_reason)));
  if prior is not null then return prior; end if;

  select * into job from public.restore_jobs where id=p_restore for update;
  if job.id is null then raise exception 'NOT_FOUND'; end if;
  if job.mode<>'RESTORE' or job.status<>'CUTOVER_REQUIRED' then raise exception 'RESTORE_STATE_INVALID'; end if;

  perform private.consume_step_up(p_step_up,'RESTORE',job.id);
  update public.restore_jobs
     set status='FAILED',
         error_code='CUTOVER_ABORTED',
         cutover_note=trim(p_reason),
         completed_at=now(),
         updated_at=now()
   where id=job.id;

  perform private.audit(
    'RESTORE_CUTOVER_ABORTED','restore_jobs',job.id,null,
    jsonb_build_object('status','CUTOVER_REQUIRED','target_reference',job.target_reference),
    jsonb_build_object('status','FAILED','error_code','CUTOVER_ABORTED','reason',trim(p_reason)),
    'FAILURE'
  );

  return private.idempotency_finish('abort_restore_cutover',p_key,jsonb_build_object('id',job.id,'status','FAILED','error_code','CUTOVER_ABORTED'));
end $$;

create or replace function public.abort_restore_cutover(
  p_restore uuid,p_step_up uuid,p_reason text,p_key uuid
) returns jsonb
language sql security invoker set search_path=''
as $$
  select private.abort_restore_cutover_impl(p_restore,p_step_up,p_reason,p_key)
$$;
revoke all on function public.abort_restore_cutover(uuid,uuid,text,uuid) from public,anon;
grant execute on function private.abort_restore_cutover_impl(uuid,uuid,text,uuid),public.abort_restore_cutover(uuid,uuid,text,uuid) to authenticated;

commit;