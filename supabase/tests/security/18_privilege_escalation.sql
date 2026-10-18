-- Privilege escalation through staff management and impersonation, with a
-- valid step-up grant so that only the authorization rules can stop it.
begin;
\ir _seed.sql
-- multi-venue waiter (A+B): a venue-A admin must not manage it.
insert into auth.users(id) values('00000000-0000-4000-8000-00000000ab01');
insert into public.staff_profiles(id,display_name,role,scope) values('00000000-0000-4000-8000-00000000ab01','Waiter AB','WAITER','VENUE');
insert into public.staff_venue_assignments(user_id,venue_id) values
  ('00000000-0000-4000-8000-00000000ab01','00000000-0000-4000-8000-000000000a01'),
  ('00000000-0000-4000-8000-00000000ab01','00000000-0000-4000-8000-000000000b01');

create or replace function pg_temp.staff_change(p_actor text,p_target uuid,p_role public.user_role,p_scope public.user_scope,p_venues uuid[]) returns text
language plpgsql as $$
declare g uuid; v bigint; actor uuid;
begin
  select id into actor from sec_actor where name=p_actor;
  insert into private.step_up_grants(user_id,session_id,action,resource_id,expires_at)
    values(actor,overlay(actor::text placing '5' from 25 for 1)::uuid,'STAFF_CHANGE',p_target,now()+interval '5 minutes') returning id into g;
  select version into v from public.staff_profiles where id=p_target;
  perform pg_temp.act(p_actor);
  perform public.update_staff_access(p_target,'Nome aggiornato',p_role,p_scope,p_venues,v,'Verifica sicurezza automatica',g,gen_random_uuid());
  execute 'reset role';
  return 'OK';
exception when others then
  execute 'reset role';
  return sqlerrm;
end $$;

do $$
declare va uuid:='00000000-0000-4000-8000-000000000a01'; vb uuid:='00000000-0000-4000-8000-000000000b01';
  waiter_a uuid:=(select id from sec_actor where name='waiter_a'); r text;
begin
  -- positive control
  r:=pg_temp.staff_change('admin_a',waiter_a,'WAITER','VENUE',array[va]);
  perform pg_temp.expect(r='OK','admin_a cannot rename its own waiter: '||r);
  perform pg_temp.expect(pg_temp.staff_change('admin_a',waiter_a,'ADMIN','VENUE',array[va])<>'OK','venue admin promotes a waiter to ADMIN');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',waiter_a,'SUPER_ADMIN','CHAIN',array[]::uuid[])<>'OK','venue admin promotes a waiter to SUPER_ADMIN');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',waiter_a,'WAITER','CHAIN',array[]::uuid[])<>'OK','venue admin grants CHAIN scope');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',waiter_a,'WAITER','VENUE',array[va,vb])<>'OK','venue admin assigns staff to a foreign venue');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',(select id from sec_actor where name='waiter_b'),'WAITER','VENUE',array[va])<>'OK','venue admin takes over staff of a foreign venue');
  perform pg_temp.expect(pg_temp.staff_change('admin_a','00000000-0000-4000-8000-00000000ab01','WAITER','VENUE',array[va])<>'OK','venue admin strips foreign-venue assignment of shared staff');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',(select id from sec_actor where name='admin_a'),'ADMIN','CHAIN',array[]::uuid[])<>'OK','admin edits its own access');
  perform pg_temp.expect(pg_temp.staff_change('admin_a',(select id from sec_actor where name='admin_b'),'WAITER','VENUE',array[va])<>'OK','venue admin demotes another admin');
  perform pg_temp.expect(pg_temp.staff_change('waiter_a',(select id from sec_actor where name='host_a'),'CASHIER','VENUE',array[va])<>'OK','waiter changes staff access');
  perform pg_temp.expect(pg_temp.staff_change('super',waiter_a,'CASHIER','VENUE',array[va])<>'OK','SUPER_ADMIN provisions non-admin roles');
  perform pg_temp.expect(pg_temp.staff_change('outsider',waiter_a,'ADMIN','VENUE',array[va])<>'OK','outsider changes staff access');
end $$;

-- Impersonation started by another SUPER_ADMIN session is not usable; read-only by default.
do $$
declare imp uuid; n bigint; super_id uuid:=(select id from sec_actor where name='super');
begin
  insert into private.impersonation_sessions(actor_id,subject_id,session_id,reason,expires_at)
    values(super_id,(select id from sec_actor where name='cashier_a'),overlay(super_id::text placing '5' from 25 for 1)::uuid,'Verifica sicurezza',now()+interval '15 minutes')
    returning id into imp;
  perform pg_temp.act('super');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',imp)::text,true);
  select count(*) into n from public.payments;
  execute 'reset role';
  perform pg_temp.expect(n=1,'impersonation control: SUPER_ADMIN impersonating cashier_a must read venue A payments');
  -- the same impersonation id replayed by a venue admin
  perform pg_temp.act('admin_b');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',imp)::text,true);
  select count(*) into n from public.payments;
  execute 'reset role';
  perform pg_temp.expect(n=0,'impersonation id replayed by another user grants access');
  -- writes refused while read-only
  perform pg_temp.act('super');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',imp)::text,true);
  begin
    perform private.authorize('00000000-0000-4000-8000-000000000a01',array['CASHIER']::public.user_role[],true);
    execute 'reset role';
    raise exception 'SECURITY_PROBE_FAILED: read-only impersonation authorized a write';
  exception when insufficient_privilege then execute 'reset role';
  end;
  update private.impersonation_sessions set expires_at=now()-interval '1 second',created_at=now()-interval '1 hour' where id=imp;
  perform pg_temp.act('super');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',imp)::text,true);
  select count(*) into n from public.payments;
  execute 'reset role';
  perform pg_temp.expect(n=0,'expired impersonation still grants access');
end $$;
rollback;
