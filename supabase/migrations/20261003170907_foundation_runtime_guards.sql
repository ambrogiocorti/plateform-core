-- Expand-only hardening of the checkpoint foundation; no business data is removed.
begin;
create function private.request_correlation_id(p_fallback uuid) returns uuid
language plpgsql stable set search_path='' as $$
declare value text;
begin
  value:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-correlation-id';
  if value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return value::uuid;end if;
  return p_fallback;
end $$;
revoke all on function private.request_correlation_id(uuid) from public,anon,authenticated;
create or replace function private.audit(p_action text,p_resource text,p_id uuid,p_venue uuid,p_old jsonb default null,p_new jsonb default null,p_result text default 'SUCCESS')
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid:=gen_random_uuid(); cid uuid; subject uuid:=private.effective_user_id(); request_headers jsonb; detail jsonb:=coalesce(p_new,p_old,'{}');
  account_ref uuid; order_ref uuid; table_ref uuid; payment_ref uuid; register_ref uuid; service_ref uuid; device_ref uuid; customer_ref uuid; payment public.payments;
begin
  request_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if request_headers->>'x-request-id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=(request_headers->>'x-request-id')::uuid; end if;
  cid:=private.request_correlation_id(rid);
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
    private.audit_values(p_old),private.audit_values(p_new),rid,cid,
    case when private.impersonation_id() is not null then auth.uid() end,
    coalesce((select write_enabled from private.impersonation_sessions where id=private.impersonation_id()),false));
end $$;
create or replace function public.ingest_edge_telemetry(p_event text,p_environment text,p_release text,p_operation text,p_duration integer,p_code text,p_status integer,p_request uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_event is null or p_event not in ('HTTP_SUCCESS','HTTP_FAILURE') or p_environment is null or p_environment not in ('development','staging','production')
    or p_release is null or length(p_release) not between 1 and 50 or p_operation is null or p_operation !~ '^[a-z_-]{1,60}$' or p_duration is null or p_duration not between 0 and 60000
    or p_code is null or p_code !~ '^[A-Z_]{1,60}$' or p_status is null or p_status not between 200 and 599 or p_request is null then raise exception 'INVALID_TELEMETRY';end if;
  insert into public.telemetry_events(event,environment,release_version,request_id,correlation_id,properties) values(p_event,p_environment,p_release,p_request,private.request_correlation_id(p_request),jsonb_build_object('operation',p_operation,'duration_ms',p_duration,'code',p_code,'status',p_status)) on conflict do nothing;
  if p_event='HTTP_FAILURE' and p_status>=500 then
    insert into public.system_errors(code,operation,request_id,correlation_id) values(p_code,p_operation,p_request,private.request_correlation_id(p_request));
    perform private.audit('EDGE_REQUEST_FAILED',p_operation,null,null,null,null,'FAILURE');
  end if;
end $$;
-- Private schemas are not exposed; RLS also denies direct access if privileges drift.
do $$ declare relation record;
begin
  for relation in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='private' and c.relkind in ('r','p') loop
    execute format('alter table private.%I enable row level security',relation.relname);
  end loop;
end $$;
commit;
