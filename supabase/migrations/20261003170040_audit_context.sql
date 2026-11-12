begin;
create or replace function private.audit_values(p_value jsonb) returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(coalesce(p_value,'{}'::jsonb))
   where key=any(array['id','venue_id','role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit_price_cents','amount_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by'])
$$;
create or replace function private.audit(p_action text,p_resource text,p_id uuid,p_venue uuid,p_old jsonb default null,p_new jsonb default null,p_result text default 'SUCCESS')
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid:=gen_random_uuid(); subject uuid:=private.effective_user_id(); request_headers jsonb; detail jsonb:=coalesce(p_new,p_old,'{}');
  account_ref uuid; order_ref uuid; table_ref uuid; payment_ref uuid; register_ref uuid; service_ref uuid; device_ref uuid; customer_ref uuid; payment public.payments;
begin
  request_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if request_headers->>'x-request-id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=(request_headers->>'x-request-id')::uuid; end if;
  account_ref:=(detail->>'account_id')::uuid; order_ref:=(detail->>'order_id')::uuid; table_ref:=(detail->>'table_id')::uuid;
  register_ref:=(detail->>'cash_register_id')::uuid; service_ref:=(detail->>'service_session_id')::uuid;
  payment_ref:=coalesce((detail->>'payment_id')::uuid,(detail->>'original_payment_id')::uuid);
  if p_resource='accounts' then account_ref:=p_id;
  elsif p_resource='orders' then order_ref:=p_id;
  elsif p_resource='payments' then payment_ref:=p_id;
  elsif p_resource='tables' then table_ref:=p_id;
  elsif p_resource='cash_registers' then register_ref:=p_id;
  elsif p_resource='service_sessions' then service_ref:=p_id;
  end if;
  if payment_ref is not null then
    select * into payment from public.payments where id=payment_ref;
    account_ref:=coalesce(account_ref,payment.account_id); register_ref:=coalesce(register_ref,payment.cash_register_id); service_ref:=coalesce(service_ref,payment.service_session_id);
  end if;
  if account_ref is null and order_ref is not null then select account_id into account_ref from public.orders where id=order_ref; end if;
  if table_ref is null and account_ref is not null then select table_id into table_ref from public.accounts where id=account_ref; end if;
  select device_id into device_ref from private.staff_sessions where session_id=private.jwt_session_id() and user_id=auth.uid();
  select id into customer_ref from private.customer_sessions where auth_user_id=auth.uid() and (account_ref is null or account_id=account_ref) order by created_at desc limit 1;
  insert into public.audit_log(venue_id,actor_type,actor_user_id,actor_role,action,resource_type,resource_id,operation,result,
    session_id,device_id,customer_session_id,table_id,account_id,order_id,payment_id,cash_register_id,service_session_id,
    old_values,new_values,request_id,correlation_id,impersonated_by,impersonation_write_enabled)
  values(p_venue,case when auth.uid() is null then 'SYSTEM' when exists(select 1 from public.staff_profiles where id=coalesce(subject,auth.uid())) then 'STAFF' else 'CUSTOMER' end,
    coalesce(subject,auth.uid()),case when auth.uid() is null then 'SYSTEM'::public.user_role else coalesce((select role from public.staff_profiles where id=coalesce(subject,auth.uid())),'CUSTOMER'::public.user_role) end,
    p_action,p_resource,p_id,p_action,p_result,private.jwt_session_id(),device_ref,customer_ref,table_ref,account_ref,order_ref,payment_ref,register_ref,service_ref,
    private.audit_values(p_old),private.audit_values(p_new),rid,rid,
    case when private.impersonation_id() is not null then auth.uid() end,
    coalesce((select write_enabled from private.impersonation_sessions where id=private.impersonation_id()),false));
end $$;

create or replace function public.force_close_account(p_account uuid,p_reason text,p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'FORCE_CLOSE',a.id);
  if p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'REASON_REQUIRED'; end if;
  if a.status='CLOSED' then raise exception 'ACCOUNT_CLOSED'; end if;
  if exists(select 1 from public.payments where account_id=a.id and status='PENDING') then raise exception 'PENDING_PAYMENT_RECONCILIATION_REQUIRED'; end if;
  perform private.audit('ACCOUNT_FORCE_CLOSED','accounts',a.id,a.venue_id,private.account_balance(a.id),jsonb_build_object('status','CLOSED','reason',trim(p_reason)));
  update public.accounts set status='CLOSED',closed_at=now(),access_epoch=access_epoch+1 where id=a.id;
  delete from private.customer_access_codes where account_id=a.id;
  update private.customer_sessions set revoked_at=now() where account_id=a.id and revoked_at is null;
  if not exists(select 1 from public.accounts where table_id=a.table_id and status<>'CLOSED') then update public.tables set technical_status='TO_RESET' where id=a.table_id; end if;
end $$;

create or replace function public.reopen_account(p_account uuid,p_reason text,p_step_up uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.accounts;
begin
  select * into a from public.accounts where id=p_account for update;
  if a.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(a.venue_id,array['ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_step_up,'REOPEN_ACCOUNT',a.id);
  if a.status<>'CLOSED' or p_reason is null or length(trim(p_reason)) not between 8 and 2000 then raise exception 'INVALID_REOPEN'; end if;
  update public.accounts set status='AT_CASHIER',closed_at=null,access_epoch=access_epoch+1 where id=a.id;
  perform private.refresh_account_payment_status(a.id);
  -- Financial reopening must not change the state of a table now used by other guests.
  perform private.audit('ACCOUNT_REOPENED','accounts',a.id,a.venue_id,jsonb_build_object('status','CLOSED'),jsonb_build_object('reason',trim(p_reason),'status',(select status from public.accounts where id=a.id)));
end $$;
commit;
