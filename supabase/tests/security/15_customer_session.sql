-- Customer (QR table) sessions: an authenticated customer reaches only the
-- account bound to its live session, never another table, venue or epoch.
begin;
\ir _seed.sql
insert into private.customer_sessions(account_id,auth_user_id,table_id,access_epoch,expires_at)
  select a.id,(select id from sec_actor where name='outsider'),a.table_id,a.access_epoch,now()+interval '2 hours'
  from public.accounts a where a.id=(select id from sec_obj where venue='a' and kind='account');
update public.tables set public_table_id=gen_random_uuid() where public_table_id is null;
create temp table sec_public_table as select o.venue,t.public_table_id from sec_obj o join public.tables t on t.id=o.id where o.kind='table';
grant select on sec_public_table to authenticated;

create or replace function pg_temp.customer_call(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.act('outsider');
  execute p_sql into r;
  execute 'reset role';
  return 'OK';
exception when others then
  execute 'reset role';
  return sqlstate;
end $$;

select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='a')))='OK','customer cannot read its own account');
select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='b')))='42501','customer reads another venue account');
select pg_temp.expect(pg_temp.customer_call(format('select public.get_account_balance(%L)::text',(select public_table_id from sec_public_table where venue='b')))<>'OK','customer reads another account balance');
select pg_temp.expect(pg_temp.customer_call(format('select public.call_waiter(%L,%L)::text',(select public_table_id from sec_public_table where venue='b'),'WAITER'))<>'OK','customer calls a waiter at another table');
select pg_temp.expect(pg_temp.customer_call(format('select public.create_customer_order_request(%L,%L::jsonb,gen_random_uuid())::text',(select public_table_id from sec_public_table where venue='b'),'[]'))<>'OK','customer orders on another table');
-- Customer has no staff visibility at all.
select pg_temp.expect(pg_temp.count_as('outsider','public.accounts')=0,'customer reads accounts table directly');
select pg_temp.expect(pg_temp.count_as('outsider','public.realtime_signals where topic=''ACCOUNT'' and account_id<>'||quote_literal((select id from sec_obj where venue='a' and kind='account')))=0,'customer reads realtime of another account');
select pg_temp.expect(pg_temp.count_as('outsider','public.realtime_signals where topic=''ACCOUNT''')>0,'customer cannot read realtime of its own account');
select pg_temp.expect(pg_temp.count_as('outsider','public.realtime_signals where topic not in (''ACCOUNT'',''PUBLIC'',''ACCESS'')')=0,'customer reads staff realtime topics');

-- Revoked session, bumped access epoch (table reset/transfer) and closed account cut access.
savepoint s; update private.customer_sessions set revoked_at=now();
select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='a')))<>'OK','revoked customer session still reads');
rollback to savepoint s;
savepoint s; update public.accounts set access_epoch=access_epoch+1 where id=(select id from sec_obj where venue='a' and kind='account');
select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='a')))<>'OK','customer session of a previous access epoch still reads');
rollback to savepoint s;
savepoint s; update private.customer_sessions set expires_at=now()-interval '1 second',created_at=now()-interval '1 hour';
select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='a')))<>'OK','expired customer session still reads');
rollback to savepoint s;
savepoint s; delete from auth.sessions where user_id=(select id from sec_actor where name='outsider');
select pg_temp.expect(pg_temp.customer_call(format('select public.get_customer_account(%L)::text',(select public_table_id from sec_public_table where venue='a')))<>'OK','customer JWT of a logged-out Auth session still reads');
rollback to savepoint s;
-- Only the service role may attach customer sessions (QR validation runs server-side).
select pg_temp.expect(not has_function_privilege('authenticated','public.attach_customer_session(uuid,uuid,uuid,integer)','execute')
  and not has_function_privilege('anon','public.attach_customer_session(uuid,uuid,uuid,integer)','execute'),'API role can attach customer sessions');
rollback;
