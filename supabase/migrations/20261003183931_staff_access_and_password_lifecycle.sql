-- Step 1: durable password changes, scoped access editing, reactivation and logout.
begin;

create or replace function public.bootstrap_technical_user(p_user uuid,p_name text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(71467001);
  if p_user is null or p_name is null or length(trim(p_name)) not between 1 and 160 then raise exception 'INVALID_STAFF_COMMAND';end if;
  if exists(select 1 from public.staff_profiles where id=p_user and role='SUPER_ADMIN' and scope='CHAIN' and active and display_name=trim(p_name)) then return;end if;
  if exists(select 1 from public.staff_profiles) then raise exception 'BOOTSTRAP_ALREADY_COMPLETED';end if;
  insert into public.staff_profiles(id,display_name,role,scope) values(p_user,trim(p_name),'SUPER_ADMIN','CHAIN');
end $$;

alter table public.staff_admin_jobs drop constraint staff_admin_jobs_action_check;
alter table public.staff_admin_jobs add constraint staff_admin_jobs_action_check
  check(action in ('CREATE','RESET_PASSWORD','RESET_MFA','DISABLE','REACTIVATE','CHANGE_PASSWORD'));

create index own_password_job_history on public.staff_admin_jobs(actor_id,created_at desc) where action='CHANGE_PASSWORD';
create index staff_session_user_lookup on private.staff_sessions(user_id);
create index staff_session_device_lookup on private.staff_sessions(device_id) where device_id is not null;
create index registered_device_user_lookup on public.registered_devices(user_id,last_seen_at desc);
create index offline_snapshot_user_lookup on public.offline_authorization_snapshots(user_id);
create index offline_snapshot_device_lookup on public.offline_authorization_snapshots(device_id);
create index station_staff_user_active on public.station_staff_assignments(user_id,venue_id) where active;
create index cashier_staff_user_active on public.cashier_assignments(user_id,venue_id) where active;
create index table_assignment_waiter_active on public.table_assignments(waiter_id,venue_id) where active;

create table private.staff_command_secret_fingerprints (
  job_id uuid primary key references public.staff_admin_jobs(id),
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$')
);
alter table private.staff_command_secret_fingerprints enable row level security;
revoke all on private.staff_command_secret_fingerprints from public,anon,authenticated,service_role;

create table private.staff_access_change_reasons (
  id uuid primary key default gen_random_uuid(),actor_id uuid not null,target_id uuid not null,
  operation_key uuid not null,reason text not null check(length(trim(reason)) between 8 and 2000),
  created_at timestamptz not null default clock_timestamp(),unique(actor_id,operation_key)
);
alter table private.staff_access_change_reasons enable row level security;
revoke all on private.staff_access_change_reasons from public,anon,authenticated,service_role;
create trigger access_reason_immutable before update or delete on private.staff_access_change_reasons
  for each row execute function private.immutable_record();
create trigger access_reason_no_truncate before truncate on private.staff_access_change_reasons
  for each statement execute function private.immutable_record();

-- JWT timestamps have second precision. Explicit session revocation provides the
-- strict guarantee; rounding permits a new full login within the same second.
create function private.invalidate_staff_access(p_user uuid,p_revoke_devices boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.staff_profiles set auth_valid_after=date_trunc('second',clock_timestamp()) where id=p_user;
  update private.staff_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where user_id=p_user;
  update public.offline_authorization_snapshots set revoked_at=coalesce(revoked_at,clock_timestamp()) where user_id=p_user;
  if p_revoke_devices then
    update public.registered_devices set revoked_at=clock_timestamp() where user_id=p_user and revoked_at is null;
  end if;
end $$;
revoke all on function private.invalidate_staff_access(uuid,boolean) from public,anon,authenticated,service_role;

alter function public.authorize_sensitive_action(text,uuid) rename to authorize_sensitive_action_step0;
alter function public.authorize_sensitive_action_step0(text,uuid) set schema private;
revoke all on function private.authorize_sensitive_action_step0(text,uuid) from public,anon,authenticated,service_role;
create function public.authorize_sensitive_action(p_action text,p_resource uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare device public.registered_devices; target uuid;
begin
  if p_action not in ('CHANGE_PASSWORD','DEVICE_REVOKE','SESSION_REVOKE') then
    return private.authorize_sensitive_action_step0(p_action,p_resource);
  end if;
  if private.real_role() is null or private.impersonation_id() is not null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if p_action='CHANGE_PASSWORD' then
    if p_resource is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode='42501';end if;
  elsif p_action='SESSION_REVOKE' then
    select user_id into target from private.staff_sessions where session_id=p_resource;
    if target is null or (target<>auth.uid() and not private.can_manage_staff(target)) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  else
    select * into device from public.registered_devices where id=p_resource;
    if device.id is null or (device.user_id<>auth.uid() and not private.can_manage_staff(device.user_id)) then
      raise exception 'FORBIDDEN' using errcode='42501';
    end if;
  end if;
  return jsonb_build_object('user_id',auth.uid(),'session_id',private.jwt_session_id());
end $$;
grant execute on function public.authorize_sensitive_action(text,uuid) to authenticated;

alter function private.staff_job_authorized(public.staff_admin_jobs) rename to administrative_staff_job_authorized;
revoke all on function private.administrative_staff_job_authorized(public.staff_admin_jobs) from public,anon,authenticated,service_role;
create function private.staff_job_authorized(p_job public.staff_admin_jobs) returns boolean
language sql stable security definer set search_path='' as $$
  select case when p_job.action='CHANGE_PASSWORD' then
    p_job.actor_id=p_job.target_user_id and exists(select 1 from public.staff_profiles where id=p_job.actor_id and active)
  else private.administrative_staff_job_authorized(p_job) end
$$;
revoke all on function private.staff_job_authorized(public.staff_admin_jobs) from public,anon,authenticated,service_role;

create function public.begin_own_password_job(p_key uuid,p_grant uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin
  if private.real_role() is null or private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if p_key is null then raise exception 'INVALID_STAFF_COMMAND';end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then
    if job.action<>'CHANGE_PASSWORD' then raise exception 'IDEMPOTENCY_MISMATCH';end if;
    return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);
  end if;
  perform 1 from public.staff_profiles where id=auth.uid() for update;
  if exists(select 1 from public.staff_admin_jobs where target_user_id=auth.uid() and status<>'COMPLETED') then
    raise exception 'STAFF_COMMAND_PENDING';
  end if;
  perform private.consume_step_up(p_grant,'CHANGE_PASSWORD',auth.uid());
  insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values)
    values(auth.uid(),p_key,auth.uid(),'CHANGE_PASSWORD','{}') returning * into job;
  perform private.audit('PASSWORD_CHANGE_AUTHORIZED','staff_profiles',auth.uid(),null);
  perform private.invalidate_staff_access(auth.uid());
  return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);
end $$;
grant execute on function public.begin_own_password_job(uuid,uuid) to authenticated;

-- Minimal recovery projection also works after this command revokes its initiating
-- operational session. No other user's job, lease or credential fingerprint is returned.
create function public.get_own_password_jobs() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from auth.sessions s join public.staff_profiles p on p.id=s.user_id
    where s.id=private.jwt_session_id() and p.id=auth.uid() and p.active) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'idempotency_key',idempotency_key,'status',status,'created_at',created_at) order by created_at desc)
    from (select id,idempotency_key,status,created_at from public.staff_admin_jobs
      where actor_id=auth.uid() and target_user_id=auth.uid() and action='CHANGE_PASSWORD' order by created_at desc limit 10) jobs),'[]');
end $$;
grant execute on function public.get_own_password_jobs() to authenticated;

alter function public.begin_staff_admin_job(text,jsonb,uuid,uuid) rename to begin_staff_admin_job_step0;
alter function public.begin_staff_admin_job_step0(text,jsonb,uuid,uuid) set schema private;
revoke all on function private.begin_staff_admin_job_step0(text,jsonb,uuid,uuid) from public,anon,authenticated,service_role;
create function public.begin_staff_admin_job(p_action text,p_values jsonb,p_key uuid,p_grant uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs; target uuid;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_STAFF_COMMAND';end if;
  if p_action='CREATE' then
    if jsonb_typeof(p_values->'venue_ids') is distinct from 'array' or jsonb_array_length(p_values->'venue_ids')>100 then raise exception 'INVALID_STAFF_COMMAND';end if;
    if exists(select 1 from jsonb_array_elements(p_values->'venue_ids') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')
      or jsonb_array_length(p_values->'venue_ids')<>(select count(distinct v) from jsonb_array_elements_text(p_values->'venue_ids') v) then raise exception 'INVALID_STAFF_COMMAND';end if;
    p_values:=p_values||jsonb_build_object('venue_ids',coalesce((select jsonb_agg(v order by v) from jsonb_array_elements_text(p_values->'venue_ids') v),'[]'));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then
    if job.action is distinct from p_action or job.values is distinct from p_values then raise exception 'IDEMPOTENCY_MISMATCH';end if;
    if not private.staff_job_authorized(job) then raise exception 'FORBIDDEN' using errcode='42501';end if;
    return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);
  end if;
  if p_action='CREATE' and exists(select 1 from auth.users where lower(email)=lower(p_values->>'identifier')) then
    raise exception 'STAFF_IDENTIFIER_TAKEN';
  end if;
  if p_action in ('RESET_PASSWORD','RESET_MFA') and exists(select 1 from public.staff_profiles where id=(p_values->>'user_id')::uuid and not active) then raise exception 'STAFF_DISABLED';end if;
  if p_action<>'REACTIVATE' then return private.begin_staff_admin_job_step0(p_action,p_values,p_key,p_grant);end if;
  if not p_values ?& array['user_id','reason','identity_verified'] or p_values-array['user_id','reason','identity_verified']<>'{}'
    or (p_values->>'identity_verified')::boolean is distinct from true or length(trim(p_values->>'reason')) not between 8 and 2000 then
    raise exception 'IDENTITY_VERIFICATION_REQUIRED';
  end if;
  target:=(p_values->>'user_id')::uuid;
  perform 1 from public.staff_profiles where id=target for update;
  if not private.can_manage_staff(target) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if exists(select 1 from public.staff_profiles where id=target and active) then raise exception 'STAFF_ALREADY_ACTIVE';end if;
  if exists(select 1 from public.staff_admin_jobs where target_user_id=target and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
  perform 1 from public.system_limits where id for update;
  if (select count(*) from public.staff_profiles where active)
    +(select count(*) from public.staff_admin_jobs where action in ('CREATE','REACTIVATE') and status<>'COMPLETED')
    >=(select max_users from public.system_limits where id) then raise exception 'STAFF_LIMIT';end if;
  perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,target);
  insert into public.staff_admin_jobs(actor_id,idempotency_key,target_user_id,action,values)
    values(auth.uid(),p_key,target,p_action,p_values) returning * into job;
  perform private.audit('STAFF_REACTIVATION_AUTHORIZED','staff_profiles',target,null);
  return jsonb_build_object('id',job.id,'user_id',target,'status',job.status);
end $$;
grant execute on function public.begin_staff_admin_job(text,jsonb,uuid,uuid) to authenticated;
-- The durable command API is the only caller allowed to stage an Auth recovery.
revoke execute on function public.revoke_staff_for_reset(uuid,uuid,boolean) from authenticated;

alter function public.resume_staff_admin_job(uuid,uuid) rename to resume_staff_admin_job_step0;
alter function public.resume_staff_admin_job_step0(uuid,uuid) set schema private;
revoke all on function private.resume_staff_admin_job_step0(uuid,uuid) from public,anon,authenticated,service_role;
create function public.resume_staff_admin_job(p_job uuid,p_grant uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin
  select * into job from public.staff_admin_jobs where id=p_job and actor_id=auth.uid() for update;
  if job.id is null or not private.staff_job_authorized(job) or private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if job.action<>'CHANGE_PASSWORD' then return private.resume_staff_admin_job_step0(p_job,p_grant);end if;
  if private.real_role() is null or job.target_user_id<>auth.uid() then raise exception 'FORBIDDEN' using errcode='42501';end if;
  perform private.consume_step_up(p_grant,'CHANGE_PASSWORD',auth.uid());
  if job.status<>'COMPLETED' then perform private.invalidate_staff_access(auth.uid());end if;
  return to_jsonb(job)-array['lease_token'];
end $$;
grant execute on function public.resume_staff_admin_job(uuid,uuid) to authenticated;

create function public.bind_staff_job_secret(p_job uuid,p_lease uuid,p_fingerprint text) returns void
language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs; stored text;
begin
  select * into job from public.staff_admin_jobs where id=p_job for update;
  if job.id is null or job.lease_token is distinct from p_lease or job.lease_until<=now()
    or job.lease_until is null or job.action not in ('CREATE','RESET_PASSWORD','CHANGE_PASSWORD') or not private.staff_job_authorized(job) then
    raise exception 'LEASE_CONFLICT';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_STAFF_COMMAND';end if;
  select fingerprint into stored from private.staff_command_secret_fingerprints where job_id=p_job;
  if stored is not null and stored<>p_fingerprint then raise exception 'IDEMPOTENCY_MISMATCH';end if;
  insert into private.staff_command_secret_fingerprints(job_id,fingerprint) values(p_job,p_fingerprint) on conflict do nothing;
end $$;
grant execute on function public.bind_staff_job_secret(uuid,uuid,text) to service_role;

create function public.verify_staff_job_secret(p_job uuid,p_fingerprint text) returns void
language plpgsql security definer set search_path='' as $$
declare stored text; job public.staff_admin_jobs;
begin
  select * into job from public.staff_admin_jobs where id=p_job;
  if job.id is null or not private.staff_job_authorized(job) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  select fingerprint into stored from private.staff_command_secret_fingerprints where job_id=p_job;
  if stored is not null and stored is distinct from p_fingerprint then raise exception 'IDEMPOTENCY_MISMATCH';end if;
end $$;
grant execute on function public.verify_staff_job_secret(uuid,text) to service_role;

create or replace function public.finish_staff_admin_job(p_job uuid,p_lease uuid,p_success boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job public.staff_admin_jobs;
begin
  select * into job from public.staff_admin_jobs where id=p_job for update;
  if job.id is null or job.lease_token is distinct from p_lease then raise exception 'LEASE_CONFLICT';end if;
  if job.status='COMPLETED' then return jsonb_build_object('id',job.target_user_id,'job_id',job.id,'status','COMPLETED');end if;
  if p_success then
    if job.lease_until<=now() or not private.staff_job_authorized(job) then raise exception 'FORBIDDEN' using errcode='42501';end if;
    perform 1 from public.staff_profiles where id=job.target_user_id for update;
    if not found then raise exception 'STAFF_PROFILE_REQUIRED';end if;
    perform private.invalidate_staff_access(job.target_user_id);
    update public.staff_profiles set active=job.action<>'DISABLE' where id=job.target_user_id;
  end if;
  update public.staff_admin_jobs set status=case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end,
    lease_until=null,last_error_code=case when p_success then null else 'REMOTE_OUTCOME_UNKNOWN' end,
    completed_at=case when p_success then now() end where id=job.id;
  perform private.audit(case when p_success then 'STAFF_COMMAND_COMPLETED' else 'STAFF_COMMAND_RECOVERY_REQUIRED' end,
    'staff_admin_jobs',job.id,null,null,jsonb_build_object('status',case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end));
  return jsonb_build_object('id',job.target_user_id,'job_id',job.id,'status',case when p_success then 'COMPLETED' else 'MANUAL_REVIEW' end);
end $$;

create function public.update_staff_access(p_user uuid,p_name text,p_role public.user_role,p_scope public.user_scope,
  p_venues uuid[],p_version bigint,p_reason text,p_grant uuid,p_key uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target public.staff_profiles; venue uuid; old_venues uuid[]; requested uuid[]; response jsonb; changed boolean;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if private.impersonation_id() is not null or not private.can_manage_staff(p_user) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160 or p_reason is null or length(trim(p_reason)) not between 8 and 2000
    or p_role is null or p_scope is null or p_venues is null or cardinality(p_venues)>100 or array_position(p_venues,null) is not null then
    raise exception 'INVALID_STAFF_COMMAND';
  end if;
  if (private.current_role()='SUPER_ADMIN' and p_role<>'ADMIN') or (private.current_role()='ADMIN' and p_role in ('ADMIN','SUPER_ADMIN','SYSTEM','CUSTOMER')) then
    raise exception 'ROLE_NOT_PROVISIONABLE';
  end if;
  if p_scope='CHAIN' and private.current_scope()<>'CHAIN' then raise exception 'SCOPE_ESCALATION';end if;
  select coalesce(array_agg(distinct v order by v),'{}') into requested from unnest(p_venues) v;
  if p_scope='VENUE' and cardinality(requested)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED';end if;
  foreach venue in array requested loop
    if not exists(select 1 from public.venues where id=venue and active) or not private.has_venue(venue) then raise exception 'VENUE_FORBIDDEN' using errcode='42501';end if;
  end loop;
  response:=private.idempotency_begin('STAFF_ACCESS',p_key,jsonb_build_object('id',p_user,'name',trim(p_name),'role',p_role,'scope',p_scope,'venues',requested,'version',p_version,'reason',trim(p_reason)));
  if response is not null then return response;end if;
  select * into target from public.staff_profiles where id=p_user for update;
  if target.version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
  if exists(select 1 from public.staff_admin_jobs where target_user_id=p_user and status<>'COMPLETED') then raise exception 'STAFF_COMMAND_PENDING';end if;
  perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,p_user);
  select coalesce(array_agg(venue_id order by venue_id),'{}') into old_venues from public.staff_venue_assignments where user_id=p_user and active;
  changed:=target.role<>p_role or target.scope<>p_scope or old_venues<>requested;
  update public.staff_profiles set display_name=trim(p_name),role=p_role,scope=p_scope where id=p_user;
  update public.staff_venue_assignments set active=false where user_id=p_user;
  foreach venue in array requested loop
    insert into public.staff_venue_assignments(user_id,venue_id) values(p_user,venue) on conflict(user_id,venue_id) do update set active=true;
  end loop;
  if changed then
    update public.table_assignments set active=false where waiter_id=p_user and active and (p_role<>'WAITER' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.station_staff_assignments set active=false where user_id=p_user and active and (p_role<>'KITCHEN_STAFF' or (p_scope='VENUE' and not venue_id=any(requested)));
    update public.cashier_assignments set active=false where user_id=p_user and active and (p_role<>'CASHIER' or (p_scope='VENUE' and not venue_id=any(requested)));
    perform private.invalidate_staff_access(p_user);
    delete from private.staff_pins where user_id=p_user;
  end if;
  insert into private.staff_access_change_reasons(actor_id,target_id,operation_key,reason) values(auth.uid(),p_user,p_key,trim(p_reason));
  foreach venue in array (select coalesce(array_agg(distinct v),'{}') from unnest(old_venues||requested) v) loop
    if (venue=any(old_venues)) is distinct from (venue=any(requested)) then
      perform private.audit('STAFF_VENUE_ACCESS_CHANGED','staff_profiles',p_user,venue,
        jsonb_build_object('active',venue=any(old_venues)),jsonb_build_object('active',venue=any(requested)));
    end if;
  end loop;
  perform private.audit('STAFF_ACCESS_CHANGED','staff_profiles',p_user,null,to_jsonb(target),jsonb_build_object('role',p_role,'scope',p_scope));
  select jsonb_build_object('id',id,'version',version) into response from public.staff_profiles where id=p_user;
  return private.idempotency_finish('STAFF_ACCESS',p_key,response);
end $$;
grant execute on function public.update_staff_access(uuid,text,public.user_role,public.user_scope,uuid[],bigint,text,uuid,uuid) to authenticated;

create function public.get_staff_management_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[],false);
  return jsonb_build_object('identity_domain',(select staff_identity_domain from public.restaurant_profile where id),
    'staff',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'display_name',p.display_name,'role',p.role,'scope',p.scope,
      'active',p.active,'version',p.version,'can_manage',private.can_manage_staff(p.id),
      'venue_ids',coalesce((select jsonb_agg(a.venue_id order by a.venue_id) from public.staff_venue_assignments a where a.user_id=p.id and a.active
        and (private.can_manage_staff(p.id) or private.has_venue(a.venue_id))),'[]')) order by p.display_name,p.id)
      from public.staff_profiles p where p.id=auth.uid() or private.current_role()='SUPER_ADMIN'
        or (private.current_role()='ADMIN' and (private.current_scope()='CHAIN' or (p.scope='VENUE' and exists(select 1 from public.staff_venue_assignments a where a.user_id=p.id and a.active and private.has_venue(a.venue_id)))))), '[]'));
end $$;
grant execute on function public.get_staff_management_workspace() to authenticated;

create function public.suggest_staff_identifier(p_name text) returns text
language plpgsql stable security definer set search_path='' as $$
declare domain text; base text; candidate text; suffix integer:=1;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[],false);
  if p_name is null or length(trim(p_name)) not between 1 and 160 then raise exception 'INVALID_STAFF_COMMAND';end if;
  select staff_identity_domain into domain from public.restaurant_profile where id;
  if domain is null then raise exception 'SETUP_REQUIRED';end if;
  base:=trim(both '.' from regexp_replace(lower(translate(trim(p_name),'àáâäèéêëìíîïòóôöùúûüçñ','aaaaeeeeiiiioooouuuucn')),'[^a-z0-9]+','.','g'));
  base:=left(coalesce(nullif(base,''),'staff'),48);candidate:=base||'@'||domain;
  while exists(select 1 from auth.users where lower(email)=candidate) or exists(select 1 from public.staff_admin_jobs where action='CREATE' and status<>'COMPLETED' and lower(values->>'identifier')=candidate) loop
    suffix:=suffix+1;candidate:=base||'.'||suffix::text||'@'||domain;
    if suffix>10000 then raise exception 'STAFF_IDENTIFIER_UNAVAILABLE';end if;
  end loop;
  return candidate;
end $$;
grant execute on function public.suggest_staff_identifier(text) to authenticated;

create function public.end_staff_session() returns void
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from auth.sessions where id=private.jwt_session_id() and user_id=auth.uid())
    or not exists(select 1 from public.staff_profiles where id=auth.uid()) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  update private.staff_sessions set revoked_at=clock_timestamp() where session_id=private.jwt_session_id() and user_id=auth.uid() and revoked_at is null;
  perform private.audit('AUTH_LOGOUT','staff_profiles',auth.uid(),null);
end $$;
grant execute on function public.end_staff_session() to authenticated;

create function public.get_own_access_sessions() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if private.real_role() is null or private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  return jsonb_build_object('session_id',private.jwt_session_id(),
    'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',s.session_id,'device_name',d.display_name,'created_at',s.created_at,
      'unlocked_until',s.unlocked_until,'current',s.session_id=private.jwt_session_id()) order by s.created_at desc)
      from private.staff_sessions s left join public.registered_devices d on d.id=s.device_id where s.user_id=auth.uid() and s.revoked_at is null),'[]'),
    'devices',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,
    'display_name',d.display_name,'platform',d.platform,'last_seen_at',d.last_seen_at,'revoked_at',d.revoked_at,
    'current',exists(select 1 from private.staff_sessions s where s.session_id=private.jwt_session_id() and s.device_id=d.id)))
    from public.registered_devices d where d.user_id=auth.uid()),'[]'));
end $$;
grant execute on function public.get_own_access_sessions() to authenticated;

create function public.revoke_staff_session(p_session uuid,p_grant uuid) returns void
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
  if private.real_role() is null or private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  select user_id into target from private.staff_sessions where session_id=p_session for update;
  if target is null or (target<>auth.uid() and not private.can_manage_staff(target)) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  perform private.consume_step_up(p_grant,'SESSION_REVOKE',p_session);
  update private.staff_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where session_id=p_session;
  perform private.audit('SESSION_REVOKED','staff_profiles',target,null,null,jsonb_build_object('revoked_at',clock_timestamp()));
end $$;
grant execute on function public.revoke_staff_session(uuid,uuid) to authenticated;

drop function public.revoke_device(uuid);
create function public.revoke_device(p_device uuid,p_grant uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare d public.registered_devices;
begin
  if private.real_role() is null or private.impersonation_id() is not null then raise exception 'FORBIDDEN' using errcode='42501';end if;
  select * into d from public.registered_devices where id=p_device for update;
  if d.id is null or (d.user_id<>auth.uid() and not private.can_manage_staff(d.user_id)) then raise exception 'FORBIDDEN' using errcode='42501';end if;
  perform private.consume_step_up(p_grant,'DEVICE_REVOKE',d.id);
  update public.registered_devices set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=d.id;
  update private.staff_sessions set revoked_at=coalesce(revoked_at,clock_timestamp()) where device_id=d.id;
  update public.offline_authorization_snapshots set revoked_at=coalesce(revoked_at,clock_timestamp()) where device_id=d.id;
  perform private.audit('DEVICE_REVOKED','registered_devices',d.id,d.venue_id,null,jsonb_build_object('revoked_at',clock_timestamp()));
end $$;
grant execute on function public.revoke_device(uuid,uuid) to authenticated;

delete from private.api_permission_manifest where function_identity='public.revoke_device(uuid)';
delete from private.api_permission_manifest where function_identity='public.revoke_staff_for_reset(uuid,uuid,boolean)' and api_role='authenticated';
insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.begin_own_password_job(uuid,uuid)','authenticated'),
  ('public.get_own_password_jobs()','authenticated'),
  ('public.bind_staff_job_secret(uuid,uuid,text)','service_role'),
  ('public.verify_staff_job_secret(uuid,text)','service_role'),
  ('public.update_staff_access(uuid,text,public.user_role,public.user_scope,uuid[],bigint,text,uuid,uuid)','authenticated'),
  ('public.get_staff_management_workspace()','authenticated'),
  ('public.suggest_staff_identifier(text)','authenticated'),
  ('public.end_staff_session()','authenticated'),
  ('public.get_own_access_sessions()','authenticated'),
  ('public.revoke_staff_session(uuid,uuid)','authenticated'),
  ('public.revoke_device(uuid,uuid)','authenticated');
notify pgrst,'reload schema';
commit;
