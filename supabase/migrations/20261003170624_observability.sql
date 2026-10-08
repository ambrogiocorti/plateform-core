begin;
create table private.device_heartbeats(device_id uuid primary key references public.registered_devices(id),last_seen_at timestamptz not null);
revoke all on private.device_heartbeats from public,anon,authenticated;
create function public.heartbeat_device() returns boolean language plpgsql security definer set search_path='' as $$
declare device uuid;
begin
  perform private.authorize(null,array['SUPER_ADMIN','ADMIN','HOST','WAITER','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],false);
  select device_id into device from private.staff_sessions where session_id=private.jwt_session_id() and user_id=auth.uid() and revoked_at is null;
  if device is null then return false;end if;
  insert into private.device_heartbeats(device_id,last_seen_at) values(device,now()) on conflict(device_id) do update set last_seen_at=excluded.last_seen_at;
  return true;
end $$;
grant execute on function public.heartbeat_device() to authenticated;
create unique index edge_telemetry_dedup on public.telemetry_events(request_id,event) where request_id is not null and event in ('HTTP_SUCCESS','HTTP_FAILURE');
create function public.ingest_edge_telemetry(p_event text,p_environment text,p_release text,p_operation text,p_duration integer,p_code text,p_status integer,p_request uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_event is null or p_event not in ('HTTP_SUCCESS','HTTP_FAILURE') or p_environment is null or p_environment not in ('development','staging','production')
    or p_release is null or length(p_release) not between 1 and 50 or p_operation is null or p_operation !~ '^[a-z_-]{1,60}$' or p_duration is null or p_duration not between 0 and 60000
    or p_code is null or p_code !~ '^[A-Z_]{1,60}$' or p_status is null or p_status not between 200 and 599 or p_request is null then raise exception 'INVALID_TELEMETRY';end if;
  insert into public.telemetry_events(event,environment,release_version,request_id,correlation_id,properties) values(p_event,p_environment,p_release,p_request,p_request,jsonb_build_object('operation',p_operation,'duration_ms',p_duration,'code',p_code,'status',p_status)) on conflict do nothing;
  if p_event='HTTP_FAILURE' and p_status>=500 then
    insert into public.system_errors(code,operation,request_id,correlation_id) values(p_code,p_operation,p_request,p_request);
    perform private.audit('EDGE_REQUEST_FAILED',p_operation,null,null,null,null,'FAILURE');
  end if;
end $$;
grant execute on function public.ingest_edge_telemetry(text,text,text,text,integer,text,integer,uuid) to service_role;
alter function public.get_technical_workspace() rename to technical_workspace_base;
alter function public.technical_workspace_base() set schema private;
revoke all on function private.technical_workspace_base() from public,anon,authenticated;
create function public.get_technical_workspace() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; metrics jsonb;
begin
  result:=private.technical_workspace_base();
  with recent as (select created_at,(properties->>'status')::integer status,case when properties->>'duration_ms' ~ '^[0-9]{1,5}$' and (properties->>'duration_ms')::integer<=60000 then (properties->>'duration_ms')::integer end duration_ms from public.telemetry_events where created_at>now()-interval '15 minutes' and event in ('HTTP_SUCCESS','HTTP_FAILURE') and properties->>'status' ~ '^[2-5][0-9]{2}$')
  select jsonb_build_object('requests',count(*),'failures',count(*) filter(where status>=500),
    'error_percent',round(100.0*count(*) filter(where status>=500)/nullif(count(*),0),2),
    'latency_p95_ms',round(percentile_cont(.95) within group(order by duration_ms)::numeric),
    'latest_at',max(created_at)) into metrics from recent;
  result:=jsonb_set(result,'{usage,recent_devices}',to_jsonb((select count(*) from public.registered_devices d left join private.device_heartbeats h on h.device_id=d.id where d.revoked_at is null and greatest(d.last_seen_at,h.last_seen_at)>now()-interval '5 minutes')));
  return result||jsonb_build_object('metrics',metrics);
end $$;
grant execute on function public.get_technical_workspace() to authenticated;
commit;
