begin;
create table public.cash_reconciliation_requests (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), service_session_id uuid not null,
  actuals jsonb not null check(jsonb_typeof(actuals)='array'), snapshot jsonb not null,
  requested_by uuid not null references public.staff_profiles(id), resolved_by uuid references public.staff_profiles(id),
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')), reason text,
  created_at timestamptz not null default now(), resolved_at timestamptz, version bigint not null default 1, updated_at timestamptz not null default now(),
  foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id)
);
create unique index one_pending_reconciliation on public.cash_reconciliation_requests(service_session_id) where status='PENDING';
alter table public.cash_reconciliation_requests enable row level security;
revoke all on public.cash_reconciliation_requests from public,anon,authenticated;
grant select on public.cash_reconciliation_requests to authenticated;
create policy finance_read on public.cash_reconciliation_requests for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN','CASHIER']::public.user_role[]));
create trigger audit_change after insert or update on public.cash_reconciliation_requests for each row execute function private.audit_row();
create trigger touch_version before update on public.cash_reconciliation_requests for each row execute function private.touch_version();
create function private.guard_reconciliation_request() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op<>'UPDATE' or old.status<>'PENDING' then raise exception 'IMMUTABLE_RECORD'; end if;
  if (to_jsonb(new)-array['status','reason','resolved_by','resolved_at','version','updated_at']) is distinct from
     (to_jsonb(old)-array['status','reason','resolved_by','resolved_at','version','updated_at']) then raise exception 'IMMUTABLE_RECORD'; end if;
  return new;
end $$;
create trigger guard_reconciliation_request before update or delete on public.cash_reconciliation_requests for each row execute function private.guard_reconciliation_request();
create trigger immutable_reconciliation_requests_truncate before truncate on public.cash_reconciliation_requests for each statement execute function private.immutable_record();

create function private.service_snapshot(p_session uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('service_session_id',s.id,'venue_id',s.venue_id,'opened_at',s.opened_at,'captured_at',now(),
    'registers',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'code',r.code,'opening_float_cents',c.opening_float_cents,
      'cash_theoretical_cents',c.opening_float_cents+coalesce((select sum(j.amount_cents+j.tip_cents) from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id and j.method='CASH'),0),
      'amount_cents',coalesce((select sum(j.amount_cents) from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id),0),
      'tip_cents',coalesce((select sum(j.tip_cents) from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id),0),
      'refund_cents',coalesce((select -sum(j.amount_cents) from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id and j.kind='REFUND'),0),
      'refund_tip_cents',coalesce((select -sum(j.tip_cents) from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id and j.kind='REFUND'),0),
      'methods',coalesce((select jsonb_agg(jsonb_build_object('method',m.method,'amount_cents',m.amount_cents,'tip_cents',m.tip_cents,'entries',m.entries) order by m.method) from (
        select j.method,sum(j.amount_cents) amount_cents,sum(j.tip_cents) tip_cents,count(*) entries from public.cash_journal j where j.service_session_id=s.id and j.cash_register_id=r.id group by j.method) m),'[]')) order by r.id)
      from public.cash_register_sessions c join public.cash_registers r on r.id=c.cash_register_id where c.service_session_id=s.id),'[]'),
    'pending_payments',(select count(*) from public.payments where service_session_id=s.id and status='PENDING'),
    'pending_refunds',(select count(*) from public.refunds where service_session_id=s.id and status in ('REQUESTED','APPROVED','PENDING')),
    'closed_accounts',(select count(distinct a.id) from public.accounts a join public.payments p on p.account_id=a.id where p.service_session_id=s.id and a.status='CLOSED'),
    'open_accounts',(select count(distinct a.id) from public.accounts a join public.payments p on p.account_id=a.id where p.service_session_id=s.id and a.status<>'CLOSED'),
    'journal_entries',(select count(*) from public.cash_journal where service_session_id=s.id))
  from public.service_sessions s where s.id=p_session
$$;

create function public.get_service_reconciliation(p_session uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare service public.service_sessions;
begin
  select * into service from public.service_sessions where id=p_session;
  if service.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(service.venue_id,array['ADMIN','CASHIER']::public.user_role[],false);
  if service.status='CLOSED' then
    return jsonb_build_object('status',service.status,'closed_at',service.closed_at,'reconciliations',(select jsonb_agg(to_jsonb(r) order by r.cash_register_id) from public.cash_reconciliations r where service_session_id=service.id));
  end if;
  return private.service_snapshot(service.id)||jsonb_build_object('status',service.status,
    'approval_request',(select to_jsonb(r) from public.cash_reconciliation_requests r where r.service_session_id=service.id and r.status='PENDING'));
end $$;

create function private.finish_service_reconciliation(p_session uuid,p_actuals jsonb,p_snapshot jsonb,p_created_by uuid,p_authorized_by uuid) returns void language plpgsql security definer set search_path='' as $$
declare register jsonb; actual bigint; venue uuid;
begin
  select venue_id into venue from public.service_sessions where id=p_session for update;
  for register in select value from jsonb_array_elements(p_snapshot->'registers') loop
    select (value->>'cash_actual_cents')::bigint into actual from jsonb_array_elements(p_actuals) where value->>'cash_register_id'=register->>'id';
    insert into public.cash_reconciliations(venue_id,service_session_id,cash_register_id,opening_float_cents,cash_theoretical_cents,cash_actual_cents,snapshot,created_by,authorized_by)
      values(venue,p_session,(register->>'id')::uuid,(register->>'opening_float_cents')::bigint,(register->>'cash_theoretical_cents')::bigint,actual,
        p_snapshot||jsonb_build_object('actuals',p_actuals),p_created_by,p_authorized_by);
  end loop;
  update public.cash_register_sessions set closed_at=now() where service_session_id=p_session and closed_at is null;
  update public.service_sessions set status='CLOSED',closed_at=now() where id=p_session;
end $$;

create function public.request_service_close(p_session uuid,p_actuals jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare service public.service_sessions; snapshot jsonb; result jsonb; register jsonb; actual bigint; difference boolean:=false; request_id uuid;
begin
  select * into service from public.service_sessions where id=p_session for update;
  if service.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(service.venue_id,array['ADMIN','CASHIER']::public.user_role[]);
  result:=private.idempotency_begin('service_close',p_key,jsonb_build_object('service',p_session,'actuals',p_actuals));
  if result is not null then return result; end if;
  if service.status<>'OPEN' then raise exception 'SERVICE_NOT_OPEN'; end if;
  if exists(select 1 from public.cash_register_sessions where service_session_id=service.id and not private.can_use_register(cash_register_id)) then raise exception 'REGISTER_FORBIDDEN'; end if;
  snapshot:=private.service_snapshot(service.id);
  if (snapshot->>'pending_payments')::bigint>0 or (snapshot->>'pending_refunds')::bigint>0 then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  if p_actuals is null or jsonb_typeof(p_actuals)<>'array' or jsonb_array_length(p_actuals)=0 or jsonb_array_length(p_actuals)<>jsonb_array_length(snapshot->'registers')
    or (select count(distinct value->>'cash_register_id') from jsonb_array_elements(p_actuals))<>jsonb_array_length(p_actuals) then raise exception 'INVALID_RECONCILIATION'; end if;
  if exists(select 1 from jsonb_array_elements(p_actuals) item where jsonb_typeof(item)<>'object' or item-array['cash_register_id','cash_actual_cents']<>'{}'::jsonb
    or jsonb_typeof(item->'cash_actual_cents') is distinct from 'number' or (item->>'cash_actual_cents') !~ '^[0-9]{1,13}$') then raise exception 'INVALID_RECONCILIATION'; end if;
  for register in select value from jsonb_array_elements(snapshot->'registers') loop
    select (value->>'cash_actual_cents')::bigint into actual from jsonb_array_elements(p_actuals) where value->>'cash_register_id'=register->>'id';
    if actual is null or actual<0 or actual>1000000000000 then raise exception 'INVALID_RECONCILIATION'; end if;
    difference:=difference or actual<>(register->>'cash_theoretical_cents')::bigint;
  end loop;
  update public.service_sessions set status='RECONCILING' where id=service.id;
  if difference then
    insert into public.cash_reconciliation_requests(venue_id,service_session_id,actuals,snapshot,requested_by)
      values(service.venue_id,service.id,p_actuals,snapshot,private.effective_user_id()) returning id into request_id;
    update public.service_sessions set status='AWAITING_APPROVAL' where id=service.id;
    insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id)
      values(service.venue_id,'ADMIN','CASH_RECONCILIATION','Differenza di cassa da approvare','cash_reconciliation_requests',request_id);
    result:=jsonb_build_object('id',service.id,'status','AWAITING_APPROVAL','request_id',request_id);
  else
    perform private.finish_service_reconciliation(service.id,p_actuals,snapshot,private.effective_user_id(),null);
    result:=jsonb_build_object('id',service.id,'status','CLOSED');
  end if;
  return private.idempotency_finish('service_close',p_key,result);
end $$;

create function public.resolve_service_reconciliation(p_request uuid,p_approve boolean,p_reason text,p_grant uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare request public.cash_reconciliation_requests; result jsonb;
begin
  select * into request from public.cash_reconciliation_requests where id=p_request;
  if request.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(request.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.service_sessions where id=request.service_session_id for update;
  select * into request from public.cash_reconciliation_requests where id=p_request for update;
  result:=private.idempotency_begin('resolve_reconciliation',p_key,jsonb_build_object('request',p_request,'approve',p_approve,'reason',p_reason));
  if result is not null then return result; end if;
  if request.status<>'PENDING' or p_approve is null or p_reason is null or length(trim(p_reason)) not between 3 and 2000 then raise exception 'INVALID_RECONCILIATION'; end if;
  perform private.consume_step_up(p_grant,'CASH_RECONCILIATION',request.id);
  if p_approve then
    perform private.finish_service_reconciliation(request.service_session_id,request.actuals,request.snapshot,request.requested_by,private.effective_user_id());
  else update public.service_sessions set status='OPEN' where id=request.service_session_id; end if;
  update public.cash_reconciliation_requests set status=case when p_approve then 'APPROVED' else 'REJECTED' end,reason=trim(p_reason),resolved_by=private.effective_user_id(),resolved_at=now() where id=request.id;
  result:=jsonb_build_object('id',request.service_session_id,'status',case when p_approve then 'CLOSED' else 'OPEN' end);
  return private.idempotency_finish('resolve_reconciliation',p_key,result);
end $$;

create function private.guard_active_register() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (tg_op='DELETE' or not new.active) and exists(select 1 from public.cash_register_sessions where cash_register_id=old.id and closed_at is null) then raise exception 'REGISTER_SERVICE_UNRECONCILED'; end if;
  return coalesce(new,old);
end $$;
create trigger guard_active_register before update or delete on public.cash_registers for each row execute function private.guard_active_register();

create or replace function public.authorize_sensitive_action(p_action text,p_resource uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare venue uuid; actor uuid;
begin
  case p_action
    when 'REFUND','CANCEL_PAYMENT' then select venue_id into venue from public.payments where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FORCE_CLOSE','REOPEN_ACCOUNT' then select venue_id into venue from public.accounts where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'CASH_RECONCILIATION' then select venue_id into venue from public.cash_reconciliation_requests where id=p_resource;
      if venue is null then raise exception 'NOT_FOUND'; end if;
      actor:=private.authorize(venue,array['ADMIN']::public.user_role[]);
    when 'FEATURE_CHANGE','INSTALLATION_STATUS','IMPERSONATION','RESTORE','DECOMMISSION','PRIVILEGED_STAFF' then actor:=private.authorize(null,array['SUPER_ADMIN']::public.user_role[]);
    when 'STAFF_CHANGE' then actor:=private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
    else raise exception 'UNKNOWN_SENSITIVE_ACTION';
  end case;
  if private.impersonation_id() is not null then raise exception 'EXIT_IMPERSONATION_FOR_STEP_UP'; end if;
  return jsonb_build_object('user_id',actor,'session_id',private.jwt_session_id());
end $$;
grant execute on function public.get_service_reconciliation(uuid),public.request_service_close(uuid,jsonb,uuid),public.resolve_service_reconciliation(uuid,boolean,text,uuid,uuid) to authenticated;
commit;
