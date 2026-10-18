-- Shared seed for security probes. Included with \ir inside a probe's own
-- transaction, which always ends in ROLLBACK: nothing persists.
-- Venue A (…a01) and venue B (…b01); one staff member per role assigned to A,
-- one VENUE-scoped admin assigned to B, one CHAIN admin, one SUPER_ADMIN,
-- one authenticated outsider without a staff profile.
set session_replication_role = origin;
insert into public.restaurant_profile(name,public_base_url,staff_base_url,staff_identity_domain)
  values('Security fixture','https://restaurant.test','https://staff.restaurant.test','staff.test');
insert into public.restaurant_settings(id) values(true) on conflict do nothing;
insert into public.system_limits(id) values(true) on conflict do nothing;
insert into public.venues(id,name,slug,code,address,phone) values
  ('00000000-0000-4000-8000-000000000a01','Sede A','sede-a','VA','Via A 1','+390000000001'),
  ('00000000-0000-4000-8000-000000000b01','Sede B','sede-b','VB','Via B 1','+390000000002');
insert into public.venue_settings(venue_id) values('00000000-0000-4000-8000-000000000a01'),('00000000-0000-4000-8000-000000000b01');

create temp table sec_actor(name text primary key, id uuid not null, role public.user_role, scope public.user_scope, venue uuid) on commit drop;
insert into sec_actor values
  ('super',        '00000000-0000-4000-8000-00000000f001','SUPER_ADMIN','CHAIN',null),
  ('chain_admin',  '00000000-0000-4000-8000-00000000f002','ADMIN','CHAIN',null),
  ('admin_a',      '00000000-0000-4000-8000-00000000a101','ADMIN','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('host_a',       '00000000-0000-4000-8000-00000000a102','HOST','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('waiter_a',     '00000000-0000-4000-8000-00000000a103','WAITER','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('cashier_a',    '00000000-0000-4000-8000-00000000a104','CASHIER','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('kadmin_a',     '00000000-0000-4000-8000-00000000a105','KITCHEN_ADMIN','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('kstaff_a',     '00000000-0000-4000-8000-00000000a106','KITCHEN_STAFF','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('pass_a',       '00000000-0000-4000-8000-00000000a107','PASS','VENUE','00000000-0000-4000-8000-000000000a01'),
  ('admin_b',      '00000000-0000-4000-8000-00000000b101','ADMIN','VENUE','00000000-0000-4000-8000-000000000b01'),
  ('waiter_b',     '00000000-0000-4000-8000-00000000b103','WAITER','VENUE','00000000-0000-4000-8000-000000000b01'),
  ('outsider',     '00000000-0000-4000-8000-00000000e001',null,null,null);
grant select on sec_actor to anon,authenticated;

insert into auth.users(id,email) select id,name||'@staff.test' from sec_actor;
insert into public.staff_profiles(id,display_name,role,scope)
  select id,initcap(name),role,scope from sec_actor where role is not null;
insert into public.staff_venue_assignments(user_id,venue_id) select id,venue from sec_actor where venue is not null;
-- session id = user id with the 'f'/'a'/'b'/'e' block replaced by 5 (deterministic, distinct)
insert into auth.sessions(id,user_id,aal) select overlay(id::text placing '5' from 25 for 1)::uuid,id,'aal2' from sec_actor;
insert into private.staff_sessions(session_id,user_id,full_auth_at,unlocked_until)
  select s.id,s.user_id,now(),now()+interval '2 hours' from auth.sessions s join sec_actor a on a.id=s.user_id where a.role is not null;

-- Act as an actor exactly as PostgREST does: JWT claims GUC + SET ROLE.
create or replace function pg_temp.act(p_name text, p_aal text default 'aal2', p_iat_offset interval default '0') returns void
language plpgsql as $$
declare v_id uuid;
begin
  execute 'reset role';
  perform set_config('request.headers','{}',true);
  if p_name='anon' then
    perform set_config('request.jwt.claims',json_build_object('role','anon')::text,true);
    execute 'set local role anon';
    return;
  end if;
  select id into strict v_id from sec_actor where name=p_name;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_id,'role','authenticated','aal',p_aal,
    'session_id',overlay(v_id::text placing '5' from 25 for 1),
    'iat',extract(epoch from now()+p_iat_offset)::bigint,
    'amr',json_build_array(json_build_object('method','password','timestamp',extract(epoch from now())::bigint))
  )::text,true);
  execute 'set local role authenticated';
end $$;

grant execute on function pg_temp.act(text,text,interval) to anon,authenticated;

create or replace function pg_temp.expect(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok,false) then raise exception 'SECURITY_PROBE_FAILED: %', p_message; end if;
end $$;
grant execute on function pg_temp.expect(boolean,text) to anon,authenticated;

-- Count rows of a relation as an actor, then return to the session owner.
create or replace function pg_temp.count_as(p_actor text, p_relation text, p_aal text default 'aal2', p_iat_offset interval default '0') returns bigint
language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.act(p_actor,p_aal,p_iat_offset);
  execute format('select count(*) from %s',p_relation) into n;
  execute 'reset role';
  return n;
end $$;

-- Operational data duplicated in both venues; ids recorded in sec_obj(venue_key, kind, id).
create temp table sec_obj(venue text, kind text, id uuid, primary key(venue,kind)) on commit drop;
grant select on sec_obj to anon,authenticated;
do $$
declare v record; v_room uuid; v_layout uuid; v_table uuid; v_account uuid; v_order uuid; v_creator uuid;
  v_service uuid; v_reservation uuid; v_register uuid; v_session uuid; v_payment uuid; v_note uuid; v_upload uuid; v_call uuid; v_waiter uuid;
begin
  for v in select * from (values ('a','00000000-0000-4000-8000-000000000a01'::uuid),('b','00000000-0000-4000-8000-000000000b01'::uuid)) x(k,id) loop
    select id into v_creator from sec_actor where name='admin_'||v.k;
    select id into v_waiter from sec_actor where name='waiter_'||v.k;
    insert into public.rooms(venue_id,name) values(v.id,'Sala '||v.k) returning id into v_room;
    insert into public.room_layouts(venue_id,room_id,name) values(v.id,v_room,'Layout '||v.k) returning id into v_layout;
    insert into public.tables(venue_id,room_id,layout_id,number,name,seats) values(v.id,v_room,v_layout,1,'T1'||v.k,4) returning id into v_table;
    insert into public.table_assignments(venue_id,waiter_id,mode,table_id) values(v.id,v_waiter,'TABLE',v_table);
    insert into public.accounts(venue_id,table_id,account_name,covers,created_by) values(v.id,v_table,'Conto '||v.k,2,v_creator) returning id into v_account;
    insert into public.orders(venue_id,account_id,origin,created_by) values(v.id,v_account,'WAITER',v_waiter) returning id into v_order;
    insert into public.services(venue_id,name,starts_at,ends_at) values(v.id,'Cena '||v.k,'19:00','23:00') returning id into v_service;
    insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,phone,party_size,status)
      values(v.id,v_service,current_date+1,'20:00','Cliente '||v.k,'+3933300000'||v.k,2,'RESERVED') returning id into v_reservation;
    insert into public.cash_registers(venue_id,name,code) values(v.id,'Cassa '||v.k,'C'||upper(v.k)) returning id into v_register;
    insert into public.service_sessions(venue_id,opened_by) values(v.id,v_creator) returning id into v_session;
    insert into public.payments(venue_id,account_id,cash_register_id,service_session_id,operator_user_id,method,amount_cents,currency,idempotency_key,status)
      values(v.id,v_account,v_register,v_session,v_creator,'CASH',1000,'EUR',gen_random_uuid(),'COMPLETED') returning id into v_payment;
    insert into public.notifications(venue_id,category,title,resource_type,resource_id,recipient_role)
      values(v.id,'OPERATIONS','Avviso '||v.k,'ACCOUNT',v_account,'ADMIN') returning id into v_note;
    insert into public.waiter_calls(venue_id,account_id,table_id,assigned_waiter_id) values(v.id,v_account,v_table,v_waiter) returning id into v_call;
    insert into public.asset_uploads(actor_id,venue_id,bucket,path,size_bytes,mime,status)
      values(v_creator,v.id,'documents','venue-'||v.k||'/contratto.pdf',100,'application/pdf','SAVED') returning id into v_upload;
    insert into storage.objects(bucket_id,name,owner) values('documents','venue-'||v.k||'/contratto.pdf',v_creator);
    insert into public.realtime_signals(topic,venue_id,account_id,resource_id)
      select t,v.id,case when t<>'PUBLIC' then v_account end,case t when 'PUBLIC' then null when 'CALL' then v_call when 'NOTIFICATION' then v_note else v_account end
      from unnest(array['PUBLIC','FLOOR','BOOKING','ACCOUNT','KITCHEN','FINANCE','CALL','NOTIFICATION','CONFIG']) t;
    insert into sec_obj values(v.k,'venue',v.id),(v.k,'room',v_room),(v.k,'layout',v_layout),(v.k,'table',v_table),(v.k,'account',v_account),
      (v.k,'order',v_order),(v.k,'service',v_service),(v.k,'reservation',v_reservation),(v.k,'register',v_register),(v.k,'session',v_session),
      (v.k,'payment',v_payment),(v.k,'notification',v_note),(v.k,'call',v_call),(v.k,'upload',v_upload);
  end loop;
end $$;
