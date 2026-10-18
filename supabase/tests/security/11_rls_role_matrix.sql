-- Role separation inside the same venue: each role reads exactly what its
-- job needs (Master Prompt role model), verified with real RLS evaluation.
begin;
\ir _seed.sql

create temp table sec_expect(actor text, relation text, expected bigint) on commit drop;
insert into sec_expect values
  -- waiter: own table's account/order/call only, never money, bookings or registers
  ('waiter_a','accounts',1),('waiter_a','orders',1),('waiter_a','waiter_calls',1),
  ('waiter_a','payments',0),('waiter_a','cash_registers',0),('waiter_a','service_sessions',0),
  ('waiter_a','reservations',0),('waiter_a','services',0),('waiter_a','notifications',0),
  ('waiter_a','staff_profiles',1),('waiter_a','registered_devices',0),('waiter_a','asset_uploads',0),
  -- host: floor and bookings, never accounts or money
  ('host_a','reservations',1),('host_a','services',1),('host_a','tables',1),
  ('host_a','accounts',0),('host_a','orders',0),('host_a','payments',0),('host_a','waiter_calls',0),
  -- cashier: accounts and money, never bookings
  ('cashier_a','accounts',1),('cashier_a','payments',1),('cashier_a','cash_registers',1),
  ('cashier_a','reservations',0),('cashier_a','services',0),('cashier_a','staff_profiles',1),
  -- kitchen: no floor accounts, money or bookings
  ('kadmin_a','accounts',0),('kadmin_a','payments',0),('kadmin_a','reservations',0),('kadmin_a','tables',0),
  ('kstaff_a','accounts',0),('kstaff_a','orders',0),('kstaff_a','payments',0),('kstaff_a','reservations',0),('kstaff_a','tables',0),
  ('pass_a','payments',0),('pass_a','reservations',0),('pass_a','accounts',0),
  -- venue admin: own venue operations, never technical/audit data reserved to SUPER_ADMIN
  ('admin_a','accounts',1),('admin_a','payments',1),('admin_a','reservations',1),('admin_a','notifications',1),
  ('admin_a','asset_uploads',1),('admin_a','audit_log',0),('admin_a','system_errors',0),
  ('admin_a','backup_metadata',0),('admin_a','restore_jobs',0),('admin_a','telemetry_events',0),
  -- SUPER_ADMIN is technical: no business/customer data without impersonation
  ('super','accounts',0),('super','orders',0),('super','payments',0),('super','reservations',0),('super','waiter_calls',0);

do $$
declare e record; n bigint;
begin
  for e in select * from sec_expect order by actor,relation loop
    perform pg_temp.act(e.actor);
    execute format('select count(*) from public.%I',e.relation) into n;
    execute 'reset role';
    perform pg_temp.expect(n=e.expected, format('%s reads %s rows of %s (expected %s)',e.actor,n,e.relation,e.expected));
  end loop;
end $$;
rollback;
