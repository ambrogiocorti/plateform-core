-- Run only on an isolated DEVELOPMENT database. All fixtures are rolled back.
-- These tests exercise real PostgreSQL roles/policies, not GoTrue or websocket delivery.
begin;
do $$
begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p') and not c.relrowsecurity)
    then raise exception 'TEST_RLS_MISSING';end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and has_function_privilege('anon',p.oid,'execute')
      and p.proname not in ('get_public_site','get_public_menu','get_booking_configuration'))
    then raise exception 'TEST_ANONYMOUS_RPC_EXPOSED';end if;
end $$;

insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
  values('Plateform test fixture','https://restaurant.test','https://restaurant.test/staff','staff.test');
insert into public.restaurant_settings(id) values(true);
insert into public.system_limits(id) values(true);
insert into public.venues(id,name,slug,code,address,phone)
  values('10000000-0000-4000-8000-000000000001','Test one','one','ONE','Test address','+39000');
insert into public.venue_settings(venue_id) values('10000000-0000-4000-8000-000000000001');
set constraints all immediate;
do $$
begin
  begin
    insert into public.venues(id,name,slug,code,address,phone)
      values('10000000-0000-4000-8000-000000000002','Test two','two','TWO','Test address','+39000');
    raise exception 'TEST_SECOND_VENUE_ACCEPTED';
  exception when check_violation then
    if sqlerrm <> 'MULTI_VENUE_DISABLED' then raise;end if;
  end;
  begin
    update public.venues set active=false;
    raise exception 'TEST_NO_ACTIVE_VENUE_ACCEPTED';
  exception when check_violation then
    if sqlerrm <> 'FIRST_VENUE_REQUIRED' then raise;end if;
  end;
end $$;
update public.feature_flags set licensed=true where name='MULTI_VENUE';
insert into public.venues(id,name,slug,code,address,phone)
  values('10000000-0000-4000-8000-000000000002','Test two','two','TWO','Test address','+39000');
insert into public.venue_settings(venue_id) values('10000000-0000-4000-8000-000000000002');
insert into auth.users(id) values
  ('20000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002'),('20000000-0000-4000-8000-000000000003');
insert into public.staff_profiles(id,display_name,role,scope) values
  ('20000000-0000-4000-8000-000000000001','Test admin','ADMIN','VENUE'),
  ('20000000-0000-4000-8000-000000000002','Test technician','SUPER_ADMIN','CHAIN'),
  ('20000000-0000-4000-8000-000000000003','Test host','HOST','VENUE');
insert into public.staff_venue_assignments(user_id,venue_id) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001');
insert into auth.sessions(id,user_id) select replace(id::text,'20000000-','30000000-')::uuid,id from public.staff_profiles;
insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
  select id,user_id,now(),now()+interval '1 hour' from auth.sessions;

select set_config('request.jwt.claims',jsonb_build_object('sub','20000000-0000-4000-8000-000000000001','aal','aal2',
  'iat',extract(epoch from now())::bigint,'session_id','30000000-0000-4000-8000-000000000001',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint)),
  'user_metadata',jsonb_build_object('role','SUPER_ADMIN','scope','CHAIN'))::text,true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.venues)<>1 then raise exception 'TEST_CROSS_VENUE_LEAK';end if;
  if private.current_role()<>'ADMIN' then raise exception 'TEST_METADATA_ESCALATION';end if;
  if exists(select 1 from public.audit_log) then raise exception 'TEST_ADMIN_TECHNICAL_AUDIT_LEAK';end if;
  begin
    update public.staff_profiles set scope='CHAIN';
    raise exception 'TEST_SCOPE_ESCALATION';
  exception when insufficient_privilege then null;end;
  begin
    perform public.consume_edge_rate_limit('unauthorized-test',10,60);
    raise exception 'TEST_SERVICE_RPC_EXPOSED';
  exception when insufficient_privilege then null;end;
end $$;
reset role;

-- Every read loses authority when the session is revoked, even with the previous JWT.
update private.staff_sessions set revoked_at=now() where user_id='20000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if exists(select 1 from public.venues) then raise exception 'TEST_REVOKED_SESSION_READ';end if;
end $$;
reset role;

select set_config('request.jwt.claims',jsonb_build_object('sub','20000000-0000-4000-8000-000000000002','aal','aal1',
  'iat',extract(epoch from now())::bigint,'session_id','30000000-0000-4000-8000-000000000002',
  'amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint)))::text,true);
set local role authenticated;
do $$ begin
  if private.current_role() is not null or exists(select 1 from public.audit_log) then raise exception 'TEST_SUPER_MFA_BYPASS';end if;
end $$;
reset role;
select set_config('request.jwt.claims','{}',true);
select set_config('request.headers','{"x-request-id":"40000000-0000-4000-8000-000000000001","x-correlation-id":"40000000-0000-4000-8000-000000000002"}',true);
select private.audit('FOUNDATION_LIVE_VERIFICATION','test',null,null,null,jsonb_build_object('password','must-not-be-logged','pin','123456','status','OPEN'));
select public.ingest_edge_telemetry('HTTP_SUCCESS','development','0.1.0','foundation',10,'OK',200,'40000000-0000-4000-8000-000000000001');
do $$ begin
  if not exists(select 1 from public.audit_log where action='FOUNDATION_LIVE_VERIFICATION'
    and request_id='40000000-0000-4000-8000-000000000001' and correlation_id='40000000-0000-4000-8000-000000000002'
    and new_values='{"status":"OPEN"}'::jsonb) then raise exception 'TEST_AUDIT_CONTEXT_OR_REDACTION';end if;
  if not exists(select 1 from public.telemetry_events where request_id='40000000-0000-4000-8000-000000000001'
    and correlation_id='40000000-0000-4000-8000-000000000002') then raise exception 'TEST_TELEMETRY_CONTEXT';end if;
  begin
    delete from public.audit_log;
    raise exception 'TEST_AUDIT_DELETE_ACCEPTED';
  exception when insufficient_privilege then
    if sqlerrm<>'IMMUTABLE_RECORD' then raise;end if;
  end;
end $$;
set local role service_role;
do $$
declare bucket text := 'foundation-live:' || gen_random_uuid()::text;
begin
  if public.consume_edge_rate_limit(bucket,2,60) is distinct from true
    or public.consume_edge_rate_limit(bucket,2,60) is distinct from true
    or public.consume_edge_rate_limit(bucket,2,60) is distinct from false
    then raise exception 'TEST_RATE_LIMIT_NOT_ENFORCED';end if;
  begin
    perform public.consume_edge_rate_limit(bucket,2,0);
    raise exception 'TEST_INVALID_RATE_LIMIT_ACCEPTED';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_RATE_LIMIT' then raise;end if;
  end;
end $$;
reset role;
rollback;
