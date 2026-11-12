begin;

create or replace function public.get_offline_sync_statuses(
  p_venue uuid,
  p_client_events uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare actor uuid;
begin
  actor:=private.authorize(
    p_venue,
    array['ADMIN','HOST','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );
  if p_venue is null or p_client_events is null or cardinality(p_client_events)>500
     or array_position(p_client_events,null) is not null then
    raise exception 'INVALID_FILTER';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'client_event_id',e.client_event_id,
      'sync_status',e.sync_status,
      'result',e.result
    ) order by e.received_at,e.id)
    from public.offline_sync_events e
    where e.venue_id=p_venue
      and e.user_id=actor
      and e.client_event_id=any(p_client_events)
  ),'[]'::jsonb);
end $$;
grant execute on function public.get_offline_sync_statuses(uuid,uuid[]) to authenticated;

create or replace function public.sync_offline_event(
  p_authorization uuid,
  p_client_event uuid,
  p_key uuid,
  p_venue uuid,
  p_resource uuid,
  p_operation text,
  p_version bigint,
  p_payload jsonb,
  p_created_at timestamptz,
  p_predecessor uuid default null
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  snapshot public.offline_authorization_snapshots;
  event_row public.offline_sync_events;
  event_result jsonb;
  reason text;
  resource_version bigint;
  resource_status text;
  ref uuid;
  order_ref uuid;
  conflict_ref uuid;
  current_profile public.staff_profiles;
  current_device public.registered_devices;
begin
  if auth.uid() is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into snapshot
    from public.offline_authorization_snapshots
   where id=p_authorization and user_id=auth.uid();
  if snapshot.id is null or not snapshot.claims->'venue_ids' @> to_jsonb(array[p_venue]) then
    raise exception 'INVALID_OFFLINE_AUTHORIZATION';
  end if;
  if (select count(*) from public.offline_sync_events where authorization_id=snapshot.id)>=500 then
    raise exception 'OFFLINE_QUEUE_LIMIT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_client_event::text,0));
  select * into event_row
    from public.offline_sync_events
   where user_id=auth.uid() and (client_event_id=p_client_event or idempotency_key=p_key);
  if event_row.id is not null then
    if event_row.client_event_id is distinct from p_client_event
       or event_row.idempotency_key is distinct from p_key
       or event_row.venue_id is distinct from p_venue
       or event_row.resource_id is distinct from p_resource
       or event_row.operation is distinct from p_operation
       or event_row.base_version is distinct from p_version
       or event_row.payload is distinct from p_payload
       or event_row.predecessor_id is distinct from p_predecessor then
      raise exception 'IDEMPOTENCY_MISMATCH';
    end if;
    return jsonb_build_object('id',event_row.id,'status',event_row.sync_status,'result',event_row.result);
  end if;
  if p_client_event is null or p_key is null or p_version is null or p_version<1
     or p_created_at is null or p_operation is null
     or p_operation not in ('CREATE_ORDER','START_STEP','SET_TABLE_AVAILABLE')
     or p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'INVALID_OFFLINE_EVENT';
  end if;

  insert into public.offline_sync_events(
    client_event_id,idempotency_key,user_id,device_id,venue_id,resource_type,resource_id,
    operation,base_version,payload,created_at_local,authorization_id,predecessor_id
  ) values(
    p_client_event,p_key,auth.uid(),snapshot.device_id,p_venue,
    case p_operation when 'CREATE_ORDER' then 'accounts' when 'START_STEP' then 'order_steps' else 'tables' end,
    p_resource,p_operation,p_version,p_payload,p_created_at,p_authorization,p_predecessor
  ) returning id into ref;

  begin
    if snapshot.revoked_at is not null then raise exception 'OFFLINE_AUTHORIZATION_CHANGED'; end if;
    if p_created_at<snapshot.issued_at-interval '2 minutes'
       or p_created_at>snapshot.expires_at
       or p_created_at>now()+interval '2 minutes' then
      raise exception 'OFFLINE_AUTHORIZATION_EXPIRED';
    end if;

    select * into current_profile from public.staff_profiles where id=auth.uid();
    if current_profile.id is null or not current_profile.active then raise exception 'OFFLINE_USER_REVOKED'; end if;
    if current_profile.role::text is distinct from snapshot.claims->>'role'
       or current_profile.scope::text is distinct from snapshot.claims->>'scope' then
      raise exception 'OFFLINE_AUTHORIZATION_CHANGED';
    end if;
    select * into current_device from public.registered_devices where id=snapshot.device_id and user_id=auth.uid();
    if current_device.id is null or current_device.revoked_at is not null then
      raise exception 'OFFLINE_DEVICE_REVOKED';
    end if;
    if not exists(
      select 1 from private.staff_sessions s
       where s.session_id=private.jwt_session_id()
         and s.user_id=auth.uid()
         and s.device_id=snapshot.device_id
         and s.revoked_at is null
         and s.unlocked_until>now()
    ) then raise exception 'OFFLINE_SESSION_REVOKED'; end if;
    if private.impersonation_id() is not null then raise exception 'OFFLINE_AUTHORIZATION_CHANGED'; end if;
    if not exists(select 1 from public.feature_flags where name='OFFLINE' and licensed) then
      raise exception 'OFFLINE_OPERATION_REVOKED';
    end if;
    if not private.has_venue(p_venue) then raise exception 'VENUE_FORBIDDEN'; end if;
    if p_predecessor is not null and not exists(
      select 1 from public.offline_sync_events
       where user_id=auth.uid()
         and client_event_id=p_predecessor
         and sync_status in ('SYNCED','REJECTED','RESOLVED')
    ) then raise exception 'CAUSAL_PREDECESSOR_REQUIRED'; end if;

    perform set_config('plateform.offline_origin','true',true);
    if p_operation='CREATE_ORDER' then
      if p_payload-array['items']<>'{}' then raise exception 'INVALID_OFFLINE_EVENT'; end if;
      if not exists(select 1 from public.accounts where id=p_resource and venue_id=p_venue) then raise exception 'NOT_FOUND'; end if;
      event_result:=public.create_order(p_resource,p_payload->'items',p_key,p_version);
      order_ref:=(event_result->>'id')::uuid;
      update public.orders set origin='OFFLINE' where id=order_ref;
    elsif p_operation='START_STEP' then
      if p_payload<>'{}' then raise exception 'INVALID_OFFLINE_EVENT'; end if;
      select version,status::text into resource_version,resource_status
        from public.order_steps where id=p_resource and venue_id=p_venue for update;
      if resource_version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
      perform public.start_order_step(p_resource);
      event_result:=jsonb_build_object('id',p_resource);
    else
      if p_payload<>'{}' then raise exception 'INVALID_OFFLINE_EVENT'; end if;
      select version,technical_status::text into resource_version,resource_status
        from public.tables where id=p_resource and venue_id=p_venue for update;
      if resource_version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
      perform public.set_table_available(p_resource);
      event_result:=jsonb_build_object('id',p_resource);
    end if;
    update public.offline_sync_events
       set sync_status='SYNCED',synced_at=now(),result=event_result
     where id=ref;
    perform private.audit(
      'OFFLINE_EVENT_SYNCED','offline_sync_events',ref,p_venue,null,
      jsonb_build_object('status','SYNCED','account_id',case when p_operation='CREATE_ORDER' then p_resource end)
    );
    perform set_config('plateform.offline_origin','false',true);
    return jsonb_build_object('id',ref,'status','SYNCED','result',event_result);
  exception when others then
    reason:=case
      when sqlerrm=any(array[
        'OUT_OF_STOCK','VERSION_CONFLICT','RESPONSIBLE_WAITER_REQUIRED','ACCOUNT_NOT_ORDERABLE',
        'OFFLINE_AUTHORIZATION_EXPIRED','OFFLINE_AUTHORIZATION_CHANGED','OFFLINE_USER_REVOKED',
        'OFFLINE_DEVICE_REVOKED','OFFLINE_SESSION_REVOKED','OFFLINE_OPERATION_REVOKED',
        'CAUSAL_PREDECESSOR_REQUIRED','FORBIDDEN','VENUE_FORBIDDEN','TABLE_STILL_IN_USE',
        'STEP_NOT_WAITING','PREVIOUS_STEP_NOT_SERVED','STEP_ROLE_FORBIDDEN'
      ]) then sqlerrm
      else 'OPERATION_REJECTED'
    end;
  end;

  if p_operation='CREATE_ORDER' then
    select version,status::text into resource_version,resource_status
      from public.accounts where id=p_resource and venue_id=p_venue;
  elsif p_operation='START_STEP' then
    select version,status::text into resource_version,resource_status
      from public.order_steps where id=p_resource and venue_id=p_venue;
  else
    select version,technical_status::text into resource_version,resource_status
      from public.tables where id=p_resource and venue_id=p_venue;
  end if;
  event_result:=jsonb_build_object('reason',reason);
  update public.offline_sync_events
     set sync_status='CONFLICT',synced_at=now(),result=event_result
   where id=ref;
  insert into public.sync_conflicts(venue_id,sync_event_id,reason_code,server_snapshot)
    values(
      p_venue,ref,reason,
      jsonb_build_object(
        'resource_id',p_resource,
        'resource_type',case p_operation when 'CREATE_ORDER' then 'accounts' when 'START_STEP' then 'order_steps' else 'tables' end,
        'version',resource_version,
        'status',resource_status,
        'captured_at',now()
      )
    ) returning id into conflict_ref;
  insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id)
    values(p_venue,'ADMIN','OFFLINE_CONFLICT','Conflitto offline da verificare','sync_conflicts',conflict_ref);
  perform private.audit(
    'OFFLINE_CONFLICT','offline_sync_events',ref,p_venue,null,
    jsonb_build_object('status','CONFLICT','reason',reason),'CONFLICT'
  );
  return jsonb_build_object('id',ref,'status','CONFLICT','result',event_result);
end $$;

grant execute on function public.sync_offline_event(uuid,uuid,uuid,uuid,uuid,text,bigint,jsonb,timestamptz,uuid) to authenticated;

create function private.step8_sync_conflict_notifications() returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.status='OPEN' and new.status in ('RESOLVED','DISCARDED') then
    update public.notifications
       set status='RESOLVED',resolved_at=coalesce(resolved_at,now())
     where venue_id=new.venue_id
       and category='OFFLINE_CONFLICT'
       and resource_type='sync_conflicts'
       and resource_id=new.id
       and status in ('NEW','ACKNOWLEDGED');
  end if;
  return new;
end $$;
create trigger step8_sync_conflict_notifications
after update of status on public.sync_conflicts
for each row execute function private.step8_sync_conflict_notifications();

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_offline_sync_statuses(uuid,uuid[])','authenticated')
on conflict do nothing;

commit;