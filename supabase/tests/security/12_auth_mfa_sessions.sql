-- Authentication state is enforced by the database, not by the UI:
-- MFA (aal2), server-side staff session, logout, stale JWT, deactivation,
-- venue/installation suspension, session binding and impersonation.
begin;
\ir _seed.sql

-- Positive controls.
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=1,'admin_a aal2 must read its account');
select pg_temp.expect(pg_temp.count_as('super','public.venues')=2,'super aal2 must read venues');
select pg_temp.expect(pg_temp.count_as('cashier_a','public.payments','aal1')=1,'cashier aal1 allowed while cashier MFA is not required');

-- MFA: ADMIN (default policy) and SUPER_ADMIN (always) need aal2.
select pg_temp.expect((select admin_mfa_required from public.restaurant_settings where id),'admin MFA must be required by default');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts','aal1')=0,'admin_a with aal1 reads accounts');
select pg_temp.expect(pg_temp.count_as('super','public.venues','aal1')=0,'super with aal1 reads venues');
select pg_temp.expect(pg_temp.count_as('chain_admin','public.accounts','aal1')=0,'chain admin with aal1 reads accounts');
savepoint s; update public.restaurant_settings set cashier_mfa_required=true where id;
select pg_temp.expect(pg_temp.count_as('cashier_a','public.payments','aal1')=0,'cashier aal1 reads payments when cashier MFA is required');
rollback to savepoint s;

-- Server-side staff session: revoked, locked, full-auth expired, logged out.
savepoint s; update private.staff_sessions set revoked_at=now() where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'revoked staff session still reads');
rollback to savepoint s;
savepoint s; update private.staff_sessions set unlocked_until=now()-interval '1 second' where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'locked staff session still reads');
rollback to savepoint s;
savepoint s; update private.staff_sessions set full_auth_at=now()-interval '1 day',full_auth_expires_at=null where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'expired full authentication still reads');
rollback to savepoint s;
savepoint s; delete from private.staff_sessions where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'JWT without server staff session still reads');
rollback to savepoint s;
savepoint s; delete from auth.sessions where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'JWT of a logged-out Auth session still reads');
rollback to savepoint s;

-- JWT issued before a forced re-authentication (password change, role change).
savepoint s; update public.staff_profiles set auth_valid_after=now()-interval '1 minute' where id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts','aal2',interval '-1 hour')=0,'stale JWT (iat before auth_valid_after) still reads');
rollback to savepoint s;

-- Deactivation of profile, assignment, venue, installation.
savepoint s; update public.staff_profiles set active=false where id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'deactivated profile still reads');
rollback to savepoint s;
savepoint s; update public.staff_venue_assignments set active=false where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'revoked venue assignment still reads');
rollback to savepoint s;
savepoint s; update public.venues set active=false where id='00000000-0000-4000-8000-000000000a01';
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'staff of a deactivated venue still reads');
rollback to savepoint s;
savepoint s; update public.restaurant_profile set status='SUSPENDED';
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'suspended installation still readable by admin');
select pg_temp.expect(pg_temp.count_as('chain_admin','public.accounts')=0,'suspended installation still readable by chain admin');
rollback to savepoint s;

-- Session binding: a JWT whose session_id belongs to another user is rejected.
do $$
declare n bigint;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',(select id from sec_actor where name='admin_a'),'role','authenticated','aal','aal2',
    'session_id',(select s.id from auth.sessions s join sec_actor a on a.id=s.user_id where a.name='cashier_a'),
    'iat',extract(epoch from now())::bigint)::text,true);
  set local role authenticated;
  select count(*) into n from public.accounts;
  reset role;
  perform pg_temp.expect(n=0,'JWT bound to another user''s session reads data');
end $$;

-- Impersonation header: ignored/rejected unless SUPER_ADMIN with a live session.
do $$
declare n bigint;
begin
  perform pg_temp.act('admin_a');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',gen_random_uuid())::text,true);
  select count(*) into n from public.accounts;
  reset role;
  perform pg_temp.expect(n=0,'non-SUPER_ADMIN with impersonation header reads data');
  perform pg_temp.act('super');
  perform set_config('request.headers',json_build_object('x-plateform-impersonation',gen_random_uuid())::text,true);
  select count(*) into n from public.accounts;
  reset role;
  perform pg_temp.expect(n=0,'SUPER_ADMIN with forged impersonation id reads data');
end $$;

-- Revoked registered device bound to the staff session.
savepoint s;
insert into public.registered_devices(id,user_id,venue_id,display_name,platform,app_version,revoked_at)
  select '00000000-0000-4000-8000-00000000d001',id,venue,'Tablet','web','1',now() from sec_actor where name='admin_a';
update private.staff_sessions set device_id='00000000-0000-4000-8000-00000000d001' where user_id=(select id from sec_actor where name='admin_a');
select pg_temp.expect(pg_temp.count_as('admin_a','public.accounts')=0,'staff session on a revoked device still reads');
rollback to savepoint s;

-- API roles can never write tables directly (all writes go through audited RPCs).
select pg_temp.expect(not exists(
  select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p','v','m')
    and (has_table_privilege('anon',c.oid,'insert,update,delete,truncate,references,trigger')
      or has_table_privilege('authenticated',c.oid,'insert,update,delete,truncate,references,trigger'))),
  'anon/authenticated hold a direct write privilege on a public/private relation');
rollback;
