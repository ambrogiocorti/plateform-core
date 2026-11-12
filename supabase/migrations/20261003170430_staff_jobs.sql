begin;
create table public.staff_admin_jobs (
  id uuid primary key default gen_random_uuid(),actor_id uuid not null references public.staff_profiles(id),idempotency_key uuid not null,target_user_id uuid not null,
  action text not null check(action in ('CREATE','RESET_PASSWORD','RESET_MFA','DISABLE')),values jsonb not null,
  status text not null default 'PENDING' check(status in ('PENDING','RUNNING','DB_READY','COMPLETED','MANUAL_REVIEW')),
  lease_token uuid,lease_until timestamptz,attempts integer not null default 0,last_error_code text,created_at timestamptz not null default now(),completed_at timestamptz,
  unique(actor_id,idempotency_key)
);
create unique index one_unfinished_staff_command on public.staff_admin_jobs(target_user_id) where status<>'COMPLETED';
create unique index one_unfinished_staff_identifier on public.staff_admin_jobs(lower(values->>'identifier')) where action='CREATE' and status<>'COMPLETED';
alter table public.staff_admin_jobs enable row level security;
revoke all on public.staff_admin_jobs from public,anon,authenticated;
grant select on public.staff_admin_jobs to authenticated;
create policy owner_read on public.staff_admin_jobs for select to authenticated using(actor_id=auth.uid() and private.is_role(array['ADMIN','SUPER_ADMIN']::public.user_role[]));
create function public.begin_staff_admin_job(p_action text,p_values jsonb,p_key uuid,p_grant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs; target uuid; v uuid; requested_role public.user_role; requested_scope public.user_scope; venues uuid[];
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then if job.action is distinct from p_action or job.values is distinct from p_values then raise exception 'IDEMPOTENCY_MISMATCH';end if;return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);end if;
  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_STAFF_COMMAND';end if;
  if p_action='CREATE' then
    if not p_values ?& array['display_name','identifier','role','scope','venue_ids'] or p_values-array['display_name','identifier','role','scope','venue_ids']<>'{}' or length(trim(p_values->>'display_name')) not between 1 and 160 or p_values->>'identifier' !~ '^[^@[:space:]]+@[^@[:space:]]+$'
      or lower(split_part(p_values->>'identifier','@',2)) is distinct from lower((select staff_identity_domain from public.restaurant_profile)) then raise exception 'INVALID_STAFF_COMMAND';end if;
    requested_role:=(p_values->>'role')::public.user_role;requested_scope:=(p_values->>'scope')::public.user_scope;
    if requested_role is null or requested_scope is null or requested_role in ('SUPER_ADMIN','SYSTEM','CUSTOMER') then raise exception 'ROLE_NOT_PROVISIONABLE';end if;
    if requested_role='ADMIN' then perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);perform private.consume_step_up(p_grant,'PRIVILEGED_STAFF');
    else perform private.consume_step_up(p_grant,'STAFF_CHANGE');end if;
    if private.current_role()='ADMIN' and requested_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
    select array_agg(x::uuid) into venues from jsonb_array_elements_text(p_values->'venue_ids') x;
    if requested_scope='VENUE' and coalesce(cardinality(venues),0)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
    foreach v in array coalesce(venues,'{}') loop if not exists(select 1 from public.venues where id=v and active) or (private.current_role()<>'SUPER_ADMIN' and not private.has_venue(v)) then raise exception 'VENUE_FORBIDDEN';end if;end loop;
    perform 1 from public.system_limits where id for update;
    if (select count(*) from public.staff_profiles where active)+(select count(*) from public.staff_admin_jobs where action='CREATE' and status<>'COMPLETED')>=(select max_users from public.system_limits where id) then raise exception 'STAFF_LIMIT';end if;
    target:=gen_random_uuid();
  elsif p_action in ('RESET_PASSWORD','RESET_MFA','DISABLE') then
    if not p_values ?& array['user_id','reason','identity_verified'] or p_values-array['user_id','reason','identity_verified']<>'{}' or (p_values->>'identity_verified')::boolean is distinct from true or length(trim(p_values->>'reason')) not between 8 and 2000 then raise exception 'IDENTITY_VERIFICATION_REQUIRED';end if;
    target:=(p_values->>'user_id')::uuid;
    if exists(select 1 from public.staff_admin_jobs where target_user_id=target and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
    perform public.revoke_staff_for_reset(target,p_grant,p_action='DISABLE');
    -- Fail closed until both Auth and PostgreSQL complete the authorized recovery.
    update public.staff_profiles set active=false where id=target;
  else raise exception 'INVALID_STAFF_COMMAND';end if;
  insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values) values(auth.uid(),p_key,target,p_action,p_values) returning * into job;
  perform private.audit('STAFF_COMMAND_AUTHORIZED','staff_admin_jobs',job.id,null,null,jsonb_build_object('status',job.status));
  return jsonb_build_object('id',job.id,'user_id',target,'status',job.status);
end $$;
grant execute on function public.begin_staff_admin_job(text,jsonb,uuid,uuid) to authenticated;
create function private.staff_job_authorized(p_job public.staff_admin_jobs) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.staff_profiles actor where actor.id=p_job.actor_id and actor.active and
    ((p_job.action='CREATE' and ((p_job.values->>'role'='ADMIN' and actor.role='SUPER_ADMIN') or (p_job.values->>'role'<>'ADMIN' and actor.role='ADMIN' and (p_job.values->>'scope'<>'CHAIN' or actor.scope='CHAIN')))
      and not exists(select 1 from jsonb_array_elements_text(p_job.values->'venue_ids') v where not exists(select 1 from public.venues where id=v::uuid and active) or (actor.role<>'SUPER_ADMIN' and actor.scope<>'CHAIN' and not exists(select 1 from public.staff_venue_assignments where user_id=actor.id and venue_id=v::uuid and active))))
     or (p_job.action<>'CREATE' and exists(select 1 from public.staff_profiles target where target.id=p_job.target_user_id and target.id<>actor.id and target.role<>'SUPER_ADMIN' and
       ((actor.role='SUPER_ADMIN' and target.role='ADMIN') or (actor.role='ADMIN' and target.role<>'ADMIN' and (actor.scope='CHAIN' or (target.scope='VENUE' and exists(select 1 from public.staff_venue_assignments where user_id=target.id and active) and not exists(select 1 from public.staff_venue_assignments ta where ta.user_id=target.id and ta.active and not exists(select 1 from public.staff_venue_assignments aa where aa.user_id=actor.id and aa.venue_id=ta.venue_id and aa.active))))))))))
$$;
create function public.resume_staff_admin_job(p_job uuid,p_grant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);select * into job from public.staff_admin_jobs where id=p_job and actor_id=auth.uid() for update;
  if job.id is null or not private.staff_job_authorized(job) then raise exception 'FORBIDDEN';end if;
  perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,case when job.action='CREATE' then null else job.target_user_id end);
  return to_jsonb(job)-array['lease_token'];
end $$;
grant execute on function public.resume_staff_admin_job(uuid,uuid) to authenticated;
create function public.claim_staff_admin_job(p_job uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin select * into job from public.staff_admin_jobs where id=p_job for update;if job.id is null or not private.staff_job_authorized(job) then raise exception 'FORBIDDEN';end if;
  if job.status='COMPLETED' then return to_jsonb(job);end if;
  if job.lease_until>now() then raise exception 'OPERATION_IN_PROGRESS';end if;
  update public.staff_admin_jobs set lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=attempts+1,status='RUNNING',last_error_code=null where id=job.id returning * into job;return to_jsonb(job);
end $$;
grant execute on function public.claim_staff_admin_job(uuid) to service_role;
create function public.prepare_staff_job_profile(p_job uuid,p_lease uuid) returns void language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs; venue uuid;
begin select * into job from public.staff_admin_jobs where id=p_job for update;if job.id is null or job.lease_token is distinct from p_lease or job.lease_until<=now() or not private.staff_job_authorized(job) then raise exception 'LEASE_CONFLICT';end if;
  if job.action='CREATE' and not exists(select 1 from public.staff_profiles where id=job.target_user_id) then
    insert into public.staff_profiles(id,display_name,role,scope,active) values(job.target_user_id,job.values->>'display_name',(job.values->>'role')::public.user_role,(job.values->>'scope')::public.user_scope,false);
    for venue in select x::uuid from jsonb_array_elements_text(job.values->'venue_ids') x loop insert into public.staff_venue_assignments(user_id,venue_id) values(job.target_user_id,venue);end loop;
  end if;
  update public.staff_admin_jobs set status='DB_READY' where id=job.id;
end $$;
grant execute on function public.prepare_staff_job_profile(uuid,uuid) to service_role;
create function public.finish_staff_admin_job(p_job uuid,p_lease uuid,p_success boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin select * into job from public.staff_admin_jobs where id=p_job for update;if job.id is null or job.lease_token is distinct from p_lease then raise exception 'LEASE_CONFLICT';end if;
  if job.status='COMPLETED' then return jsonb_build_object('id',job.target_user_id,'job_id',job.id,'status','COMPLETED');end if;
  if p_success then
    if job.lease_until<=now() or not private.staff_job_authorized(job) then raise exception 'FORBIDDEN';end if;
    update public.staff_profiles set active=job.action<>'DISABLE',auth_valid_after=now() where id=job.target_user_id;
    if not found then raise exception 'STAFF_PROFILE_REQUIRED';end if;
  end if;
  update public.staff_admin_jobs set status=case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end,lease_until=null,last_error_code=case when p_success then null else 'REMOTE_OUTCOME_UNKNOWN' end,completed_at=case when p_success then now() end where id=job.id;
  perform private.audit(case when p_success then 'STAFF_COMMAND_COMPLETED' else 'STAFF_COMMAND_RECOVERY_REQUIRED' end,'staff_admin_jobs',job.id,null,null,jsonb_build_object('status',case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end));
  return jsonb_build_object('id',job.target_user_id,'job_id',job.id,'status',case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end);
end $$;
grant execute on function public.finish_staff_admin_job(uuid,uuid,boolean) to service_role;
revoke execute on function public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid) from authenticated;
commit;
