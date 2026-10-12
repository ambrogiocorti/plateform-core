begin;
create function public.get_offline_operational_workspace(p_venue uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare floor jsonb:=null; kitchen jsonb:='[]'; starter boolean;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],false);
  if p_venue is null then raise exception 'VENUE_REQUIRED';end if;
  if private.current_role() in ('ADMIN','HOST','WAITER','PASS') then floor:=public.get_floor_workspace(p_venue);end if;
  if private.current_role() in ('ADMIN','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS') then kitchen:=public.get_kitchen_board(p_venue);end if;
  starter:=private.current_role() in ('WAITER','KITCHEN_ADMIN','PASS') and exists(select 1 from public.venue_settings where venue_id=p_venue and private.current_role()=any(step_starter_roles));
  return jsonb_build_object('captured_at',now(),'floor',floor,'kitchen',kitchen,
    'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.account_name,'version',a.version,'table_id',a.table_id) order by a.created_at) from public.accounts a
      where a.venue_id=p_venue and a.status in ('OPEN','BILL_REQUESTED') and private.current_role()='WAITER' and private.responsible_waiter(a.table_id)=private.effective_user_id()),'[]'),
    'steps',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'version',s.version,'number',s.step_number,'table_name',t.name,'can_start',starter
      and (private.current_role()<>'WAITER' or private.responsible_waiter(t.id)=private.effective_user_id())
      and not exists(select 1 from public.order_steps prev where prev.order_id=s.order_id and prev.step_number<s.step_number and prev.status not in ('SERVED','CANCELLED'))) order by o.created_at,s.step_number)
      from public.order_steps s join public.orders o on o.id=s.order_id join public.accounts a on a.id=o.account_id join public.tables t on t.id=a.table_id
      where s.venue_id=p_venue and s.status='WAITING' and a.floor_released_at is null and exists(select 1 from jsonb_array_elements(kitchen) line where line->>'step_id'=s.id::text)),'[]'),
    'reset_tables',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'version',t.version)) from public.tables t join public.room_layouts l on l.id=t.layout_id and l.active and not l.archived
      where t.venue_id=p_venue and t.active and t.technical_status='TO_RESET' and private.current_role() in ('ADMIN','HOST','WAITER')
      and (private.current_role()<>'WAITER' or private.responsible_waiter(t.id)=private.effective_user_id())
      and not exists(select 1 from public.accounts where table_id=any(private.table_group(t.id)) and floor_released_at is null)
      and not exists(select 1 from public.reservations where table_id=any(private.table_group(t.id)) and status in ('ARRIVED','SEATED'))),'[]'));
end $$;
grant execute on function public.get_offline_operational_workspace(uuid) to authenticated;
create or replace function public.sync_offline_event(p_authorization uuid,p_client_event uuid,p_key uuid,p_venue uuid,p_resource uuid,p_operation text,p_version bigint,p_payload jsonb,p_created_at timestamptz,p_predecessor uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
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
      perform public.start_order_step(p_resource);event_result:=jsonb_build_object('id',p_resource);
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
    reason:=case when sqlerrm=any(array['OUT_OF_STOCK','VERSION_CONFLICT','RESPONSIBLE_WAITER_REQUIRED','ACCOUNT_NOT_ORDERABLE','OFFLINE_AUTHORIZATION_EXPIRED','OFFLINE_AUTHORIZATION_CHANGED','CAUSAL_PREDECESSOR_REQUIRED','FORBIDDEN','TABLE_STILL_IN_USE','STEP_NOT_WAITING','PREVIOUS_STEP_NOT_SERVED','STEP_ROLE_FORBIDDEN']) then sqlerrm else 'OPERATION_REJECTED' end;
  end;
  event_result:=jsonb_build_object('reason',reason);
  update public.offline_sync_events set sync_status='CONFLICT',synced_at=now(),result=event_result where id=ref;
  insert into public.sync_conflicts(venue_id,sync_event_id,reason_code,server_snapshot) values(p_venue,ref,reason,jsonb_build_object('resource_id',p_resource,'version',resource_version));
  perform private.audit('OFFLINE_CONFLICT','offline_sync_events',ref,p_venue,null,jsonb_build_object('status','CONFLICT'),'CONFLICT');
  return jsonb_build_object('id',ref,'status','CONFLICT','result',event_result);
end $$;
commit;
