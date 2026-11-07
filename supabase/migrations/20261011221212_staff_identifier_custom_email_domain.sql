-- Staff identifiers retain an email format for Supabase Auth, but privileged
-- operators may customize the domain. Suggestions continue to use the
-- configured stable default domain. Existing user identifiers are unchanged.
-- All MFA, role/scope, venue, rate limit and duplicate checks remain intact.

CREATE OR REPLACE FUNCTION private.begin_staff_admin_job_step0(p_action text, p_values jsonb, p_key uuid, p_grant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare job public.staff_admin_jobs; target uuid; v uuid; requested_role public.user_role; requested_scope public.user_scope; venues uuid[];
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_key::text,0));
  select * into job from public.staff_admin_jobs where actor_id=auth.uid() and idempotency_key=p_key;
  if job.id is not null then if job.action is distinct from p_action or job.values is distinct from p_values then raise exception 'IDEMPOTENCY_MISMATCH';end if;return jsonb_build_object('id',job.id,'user_id',job.target_user_id,'status',job.status);end if;
  if p_key is null or p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'INVALID_STAFF_COMMAND';end if;
  if p_action='CREATE' then
    if not p_values ?& array['display_name','identifier','role','scope','venue_ids'] or p_values-array['display_name','identifier','role','scope','venue_ids']<>'{}' or length(trim(p_values->>'display_name')) not between 1 and 160 or p_values->>'identifier' !~ '^[^@[:space:]]+@[^@[:space:]]+$'
      then raise exception 'INVALID_STAFF_COMMAND';end if;
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
end $function$

