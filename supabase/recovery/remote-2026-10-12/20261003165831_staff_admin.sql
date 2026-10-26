begin;
create function public.bootstrap_technical_user(p_user uuid,p_name text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(71467001);
  if exists(select 1 from public.staff_profiles) then raise exception 'BOOTSTRAP_ALREADY_COMPLETED'; end if;
  insert into public.staff_profiles(id,display_name,role,scope) values(p_user,p_name,'SUPER_ADMIN','CHAIN');
end $$;
grant execute on function public.bootstrap_technical_user(uuid,text) to service_role;

create function public.authorize_sensitive_action(p_action text,p_resource uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare venue uuid; actor uuid;
begin
  case p_action
    when 'REFUND','CANCEL_PAYMENT' then select venue_id into venue from public.payments where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FORCE_CLOSE','REOPEN_ACCOUNT' then select venue_id into venue from public.accounts where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FEATURE_CHANGE','INSTALLATION_STATUS','IMPERSONATION','RESTORE','DECOMMISSION','PRIVILEGED_STAFF' then
      actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
    when 'STAFF_CHANGE' then actor:=private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
    else raise exception 'UNKNOWN_SENSITIVE_ACTION';
  end case;
  if private.impersonation_id() is not null then raise exception 'EXIT_IMPERSONATION_FOR_STEP_UP'; end if;
  return jsonb_build_object('user_id',actor,'session_id',private.jwt_session_id());
end $$;
grant execute on function public.authorize_sensitive_action(text,uuid) to authenticated;

create function public.issue_step_up_grant(p_user uuid,p_session uuid,p_action text,p_resource uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare ref uuid;
begin
  if not exists(select 1 from public.staff_profiles p join auth.sessions s on s.user_id=p.id where p.id=p_user and p.active and s.id=p_session) then raise exception 'INVALID_SESSION'; end if;
  insert into private.step_up_grants(user_id,session_id,action,resource_id,expires_at) values(p_user,p_session,p_action,p_resource,now()+interval '3 minutes') returning id into ref;
  perform private.audit('STEP_UP_AUTHENTICATED','staff_profiles',p_user,null);
  return ref;
end $$;
grant execute on function public.issue_step_up_grant(uuid,uuid,text,uuid) to service_role;

create function public.provision_staff_profile(p_user uuid,p_name text,p_role public.user_role,p_scope public.user_scope,p_venues uuid[],p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
declare v uuid;
begin
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  if p_role in ('SYSTEM','CUSTOMER','SUPER_ADMIN') then raise exception 'ROLE_NOT_PROVISIONABLE'; end if;
  if p_role='ADMIN' then
    perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
    perform private.consume_step_up(p_step_up,'PRIVILEGED_STAFF');
  else
    perform private.consume_step_up(p_step_up,'STAFF_CHANGE');
    if private.current_role()='ADMIN' and (p_scope='CHAIN' and private.current_scope()<>'CHAIN') then raise exception 'SCOPE_ESCALATION'; end if;
  end if;
  if p_scope='VENUE' and coalesce(cardinality(p_venues),0)=0 then raise exception 'VENUE_ASSIGNMENT_REQUIRED'; end if;
  foreach v in array p_venues loop
    if private.current_role()<>'SUPER_ADMIN' and not private.has_venue(v) then raise exception 'VENUE_FORBIDDEN' using errcode='42501'; end if;
  end loop;
  perform 1 from public.system_limits where id for update;
  if (select count(*) from public.staff_profiles where active)>=(select max_users from public.system_limits where id) then raise exception 'STAFF_LIMIT'; end if;
  insert into public.staff_profiles(id,display_name,role,scope) values(p_user,p_name,p_role,p_scope);
  insert into public.staff_venue_assignments(user_id,venue_id) select p_user,unnest(p_venues);
end $$;
grant execute on function public.provision_staff_profile(uuid,text,public.user_role,public.user_scope,uuid[],uuid) to authenticated;

create function public.force_close_account(p_account uuid,p_reason text,p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'FORCE_CLOSE',a.id);
  if length(trim(p_reason))<8 then raise exception 'REASON_REQUIRED'; end if;
  if exists(select 1 from public.payments where account_id=a.id and status='PENDING') then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  perform private.audit('ACCOUNT_FORCE_CLOSED','accounts',a.id,a.venue_id,private.account_balance(a.id),jsonb_build_object('status','CLOSED'));
  update public.accounts set status='CLOSED',closed_at=now(),access_epoch=access_epoch+1 where id=a.id;
  delete from private.customer_access_codes where account_id=a.id;
  update private.customer_sessions set revoked_at=now() where account_id=a.id and revoked_at is null;
  if not exists(select 1 from public.accounts where table_id=a.table_id and status<>'CLOSED') then update public.tables set technical_status='TO_RESET' where id=a.table_id; end if;
end $$;
create function public.reopen_account(p_account uuid,p_reason text,p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'REOPEN_ACCOUNT',a.id);
  if a.status<>'CLOSED' or length(trim(p_reason))<8 then raise exception 'INVALID_REOPEN'; end if;
  update public.accounts set status='AT_CASHIER',closed_at=null,access_epoch=access_epoch+1 where id=a.id;
  perform private.refresh_account_payment_status(a.id);
  update public.tables set technical_status='PAYMENT' where id=a.table_id;
  perform private.audit('ACCOUNT_REOPENED','accounts',a.id,a.venue_id);
end $$;
grant execute on function public.force_close_account(uuid,text,uuid),public.reopen_account(uuid,text,uuid) to authenticated;
commit;
