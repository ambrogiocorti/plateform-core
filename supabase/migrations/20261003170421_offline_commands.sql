begin;
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
    old_values,new_values,request_id,correlation_id,impersonated_by,impersonation_write_enabled,offline_origin,synced_at)
  values(p_venue,case when auth.uid() is null then 'SYSTEM' when exists(select 1 from public.staff_profiles where id=coalesce(subject,auth.uid())) then 'STAFF' else 'CUSTOMER' end,
    coalesce(subject,auth.uid()),case when auth.uid() is null then 'SYSTEM'::public.user_role else coalesce((select role from public.staff_profiles where id=coalesce(subject,auth.uid())),'CUSTOMER'::public.user_role) end,
    p_action,p_resource,p_id,p_action,p_result,private.jwt_session_id(),device_ref,customer_ref,table_ref,account_ref,order_ref,payment_ref,register_ref,service_ref,
    private.audit_values(p_old),private.audit_values(p_new),rid,rid,
    case when private.impersonation_id() is not null then auth.uid() end,
    coalesce((select write_enabled from private.impersonation_sessions where id=private.impersonation_id()),false),
    coalesce(nullif(current_setting('plateform.offline_origin',true),''),'false')::boolean,
    case when coalesce(nullif(current_setting('plateform.offline_origin',true),''),'false')::boolean then now() end);
end $$;

create table private.offline_challenges(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.staff_profiles(id),session_id uuid not null,claims jsonb not null,expires_at timestamptz not null default now()+interval '1 minute',consumed_at timestamptz);
alter table public.offline_sync_events add column authorization_id uuid references public.offline_authorization_snapshots(id);
alter table public.offline_sync_events add column predecessor_id uuid;
create function public.prepare_offline_authorization() returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.staff_sessions; p public.staff_profiles; claims jsonb; challenge uuid; expires timestamptz;
begin
  perform private.authorize(null,array['ADMIN','HOST','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]);
  if private.impersonation_id() is not null or not exists(select 1 from public.feature_flags where name='OFFLINE' and licensed) then raise exception 'OFFLINE_NOT_AVAILABLE';end if;
  select * into s from private.staff_sessions where session_id=private.jwt_session_id() and revoked_at is null;
  select * into p from public.staff_profiles where id=auth.uid();
  if s.device_id is null or exists(select 1 from public.registered_devices where id=s.device_id and revoked_at is not null) then raise exception 'DEVICE_REVOKED';end if;
  expires:=least(s.unlocked_until,now()+make_interval(mins=>(select offline_ttl_minutes from public.restaurant_settings where id)));
  if expires<=now() then raise exception 'FULL_AUTH_REQUIRED';end if;
  claims:=jsonb_build_object('user_id',p.id,'role',p.role,'scope',p.scope,'device_id',s.device_id,'issued_at',now(),'expires_at',expires,
    'venue_ids',coalesce((select jsonb_agg(id order by id) from public.venues where active and private.has_venue(id)),'[]'),
    'operational_assignments',jsonb_build_object('tables',coalesce((select jsonb_agg(jsonb_build_object('venue_id',venue_id,'table_id',table_id,'zone_id',zone_id,'mode',mode)) from public.table_assignments where waiter_id=p.id and active),'[]'),
      'stations',coalesce((select jsonb_agg(jsonb_build_object('venue_id',venue_id,'station_id',station_id)) from public.station_staff_assignments where user_id=p.id and active),'[]')));
  insert into private.offline_challenges(user_id,session_id,claims) values(p.id,s.session_id,claims) returning id into challenge;
  return jsonb_build_object('challenge_id',challenge,'claims',claims);
end $$;
grant execute on function public.prepare_offline_authorization() to authenticated;
create function public.store_offline_authorization(p_challenge uuid,p_claims text,p_signature text) returns uuid language plpgsql security definer set search_path='' as $$
declare c private.offline_challenges; ref uuid;
begin select * into c from private.offline_challenges where id=p_challenge for update;
  if c.id is null or c.consumed_at is not null or c.expires_at<=now() or c.claims is distinct from p_claims::jsonb or length(p_signature) not between 64 and 200 then raise exception 'INVALID_OFFLINE_AUTHORIZATION';end if;
  insert into public.offline_authorization_snapshots(user_id,device_id,claims,signature,expires_at) values(c.user_id,(c.claims->>'device_id')::uuid,c.claims,p_signature,(c.claims->>'expires_at')::timestamptz) returning id into ref;
  update private.offline_challenges set consumed_at=now() where id=c.id;return ref;
end $$;
grant execute on function public.store_offline_authorization(uuid,text,text) to service_role;

create function public.sync_offline_event(p_authorization uuid,p_client_event uuid,p_key uuid,p_venue uuid,p_resource uuid,p_operation text,p_version bigint,p_payload jsonb,p_created_at timestamptz,p_predecessor uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare snapshot public.offline_authorization_snapshots; event_row public.offline_sync_events; event_result jsonb; reason text; resource_version bigint; ref uuid; order_ref uuid;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]);
  select * into snapshot from public.offline_authorization_snapshots where id=p_authorization and user_id=auth.uid();
  if snapshot.id is null then raise exception 'INVALID_OFFLINE_AUTHORIZATION';end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_client_event::text,0));
  select * into event_row from public.offline_sync_events where user_id=auth.uid() and (client_event_id=p_client_event or idempotency_key=p_key);
  if event_row.id is not null then
    if event_row.client_event_id is distinct from p_client_event or event_row.idempotency_key is distinct from p_key or event_row.venue_id is distinct from p_venue or event_row.resource_id is distinct from p_resource or event_row.operation is distinct from p_operation or event_row.base_version is distinct from p_version or event_row.payload is distinct from p_payload or event_row.predecessor_id is distinct from p_predecessor then raise exception 'IDEMPOTENCY_MISMATCH';end if;
    return jsonb_build_object('id',event_row.id,'status',event_row.sync_status,'result',event_row.result);
  end if;
  if p_client_event is null or p_key is null or p_version is null or p_version<1 or p_created_at is null or p_operation is null or p_operation not in ('CREATE_ORDER','START_STEP','SET_TABLE_AVAILABLE') or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'INVALID_OFFLINE_EVENT';end if;
  insert into public.offline_sync_events(client_event_id,idempotency_key,user_id,device_id,venue_id,resource_type,resource_id,operation,base_version,payload,created_at_local,authorization_id,predecessor_id)
    values(p_client_event,p_key,auth.uid(),snapshot.device_id,p_venue,case p_operation when 'CREATE_ORDER' then 'accounts' when 'START_STEP' then 'order_steps' else 'tables' end,p_resource,p_operation,p_version,p_payload,p_created_at,p_authorization,p_predecessor) returning id into ref;
  begin
    if snapshot.revoked_at is not null or snapshot.expires_at<=now() or p_created_at<snapshot.issued_at-interval '2 minutes' or p_created_at>snapshot.expires_at or p_created_at>now()+interval '2 minutes' then raise exception 'OFFLINE_AUTHORIZATION_EXPIRED';end if;
    if private.impersonation_id() is not null or snapshot.claims->>'role' is distinct from private.current_role()::text or not snapshot.claims->'venue_ids' @> to_jsonb(array[p_venue])
      or not exists(select 1 from private.staff_sessions where session_id=private.jwt_session_id() and device_id=snapshot.device_id and revoked_at is null)
      or not exists(select 1 from public.feature_flags where name='OFFLINE' and licensed) then raise exception 'OFFLINE_AUTHORIZATION_CHANGED';end if;
    if p_predecessor is not null and not exists(select 1 from public.offline_sync_events where user_id=auth.uid() and client_event_id=p_predecessor and sync_status in ('SYNCED','RESOLVED')) then raise exception 'CAUSAL_PREDECESSOR_REQUIRED';end if;
    perform set_config('plateform.offline_origin','true',true);
    if p_operation='CREATE_ORDER' then
      if p_payload-array['items']<>'{}' then raise exception 'INVALID_OFFLINE_EVENT';end if;
      if not exists(select 1 from public.accounts where id=p_resource and venue_id=p_venue) then raise exception 'NOT_FOUND';end if;
      event_result:=public.create_order(p_resource,p_payload->'items',p_key,p_version);
      order_ref:=(event_result->>'id')::uuid;
      update public.orders set origin='OFFLINE' where id=order_ref;
    elsif p_operation='START_STEP' then
      if p_payload<>'{}' then raise exception 'INVALID_OFFLINE_EVENT';end if;
      select version into resource_version from public.order_steps where id=p_resource and venue_id=p_venue for update;
      if resource_version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
      perform public.start_step(p_resource);event_result:=jsonb_build_object('id',p_resource);
    else
      if p_payload<>'{}' then raise exception 'INVALID_OFFLINE_EVENT';end if;
      select version into resource_version from public.tables where id=p_resource and venue_id=p_venue for update;
      if resource_version is distinct from p_version then raise exception 'VERSION_CONFLICT';end if;
      perform public.set_table_available(p_resource);event_result:=jsonb_build_object('id',p_resource);
    end if;
    update public.offline_sync_events set sync_status='SYNCED',synced_at=now(),result=event_result where id=ref;
    perform private.audit('OFFLINE_EVENT_SYNCED','offline_sync_events',ref,p_venue,null,jsonb_build_object('status','SYNCED','account_id',case when p_operation='CREATE_ORDER' then p_resource end));
    perform set_config('plateform.offline_origin','false',true);
    return jsonb_build_object('id',ref,'status','SYNCED','result',event_result);
  exception when others then
    reason:=case when sqlerrm=any(array['OUT_OF_STOCK','VERSION_CONFLICT','RESPONSIBLE_WAITER_REQUIRED','ACCOUNT_NOT_ORDERABLE','OFFLINE_AUTHORIZATION_EXPIRED','OFFLINE_AUTHORIZATION_CHANGED','CAUSAL_PREDECESSOR_REQUIRED','FORBIDDEN','TABLE_STILL_IN_USE','STEP_NOT_WAITING']) then sqlerrm else 'OPERATION_REJECTED' end;
  end;
  event_result:=jsonb_build_object('reason',reason);
  update public.offline_sync_events set sync_status='CONFLICT',synced_at=now(),result=event_result where id=ref;
  insert into public.sync_conflicts(venue_id,sync_event_id,reason_code,server_snapshot) values(p_venue,ref,reason,jsonb_build_object('resource_id',p_resource,'version',resource_version));
  perform private.audit('OFFLINE_CONFLICT','offline_sync_events',ref,p_venue,null,jsonb_build_object('status','CONFLICT'),'CONFLICT');
  return jsonb_build_object('id',ref,'status','CONFLICT','result',event_result);
end $$;
grant execute on function public.sync_offline_event(uuid,uuid,uuid,uuid,uuid,text,bigint,jsonb,timestamptz,uuid) to authenticated;
create function public.resolve_sync_conflict(p_conflict uuid,p_action text,p_reason text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare conflict_row public.sync_conflicts; result jsonb;
begin select * into conflict_row from public.sync_conflicts where id=p_conflict for update;if conflict_row.id is null then raise exception 'NOT_FOUND';end if;perform private.authorize(conflict_row.venue_id,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('conflict_resolution',p_key,jsonb_build_object('conflict',p_conflict,'action',p_action,'reason',p_reason));if result is not null then return result;end if;
  if conflict_row.status<>'OPEN' or p_action is null or p_action not in ('DISCARD','ACKNOWLEDGE') or p_reason is null or length(trim(p_reason))<3 then raise exception 'INVALID_CONFLICT_RESOLUTION';end if;
  update public.sync_conflicts set status=case when p_action='DISCARD' then 'DISCARDED' else 'RESOLVED' end,resolution=jsonb_build_object('action',p_action,'reason',p_reason),resolved_by=private.effective_user_id(),resolved_at=now() where id=conflict_row.id;
  -- Acknowledgement never means that the rejected business operation was executed.
  update public.offline_sync_events set sync_status='REJECTED' where id=conflict_row.sync_event_id;
  perform private.audit('OFFLINE_CONFLICT_RESOLVED','sync_conflicts',conflict_row.id,conflict_row.venue_id,null,jsonb_build_object('status','REJECTED'));
  return private.idempotency_finish('conflict_resolution',p_key,jsonb_build_object('id',conflict_row.id));
end $$;
grant execute on function public.resolve_sync_conflict(uuid,text,text,uuid) to authenticated;
commit;
