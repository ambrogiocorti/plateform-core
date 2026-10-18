-- Structural invariants: every private function a policy calls is executable
-- by the policy's roles; internal helpers are not; venue-scoped references
-- cannot cross venues.
begin;
\ir _seed.sql

-- A predicate the role cannot execute turns RLS filtering into a 42501 error.
do $$
declare r record;
begin
  for r in
    select distinct pol.tablename, pol.policyname, role_name, p.oid::regprocedure fn
    from pg_policies pol
    cross join lateral unnest(pol.roles) role_name
    cross join lateral regexp_matches(coalesce(pol.qual,'')||' '||coalesce(pol.with_check,''),'private\."?([a-z_]+)"?\(','g') m
    join pg_proc p on p.proname=m[1] and p.pronamespace='private'::regnamespace
    where pol.schemaname in ('public','storage') and role_name in ('anon','authenticated')
      and not has_function_privilege(role_name,p.oid,'execute')
  loop
    raise exception 'SECURITY_PROBE_FAILED: policy %.% for % calls non-executable %',r.tablename,r.policyname,r.role_name,r.fn;
  end loop;
end $$;

-- Direct reads of menu tables are filtered, not rejected.
do $$
declare t text; n bigint;
begin
  foreach t in array array['menus','menu_venues','menu_categories','menu_dishes','menu_promotions'] loop
    perform pg_temp.act('waiter_a');
    execute format('select count(*) from public.%I',t) into n;
    execute 'reset role';
    perform pg_temp.act('admin_a');
    execute format('select count(*) from public.%I',t) into n;
    execute 'reset role';
  end loop;
end $$;

select pg_temp.expect(not has_function_privilege('authenticated','private.responsible_waiter(uuid)','execute'),'responsible_waiter is callable by authenticated');
select pg_temp.expect(not has_function_privilege('anon','private.responsible_waiter(uuid)','execute'),'responsible_waiter is callable by anon');

-- Every single-column reference between venue-scoped tables is venue-checked.
select pg_temp.expect(not exists(
  select 1 from pg_constraint c
  where c.contype='f' and c.connamespace='public'::regnamespace and c.confrelid<>'public.venues'::regclass
    and exists(select 1 from pg_attribute where attrelid=c.conrelid and attname='venue_id' and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=c.confrelid and attname='venue_id' and not attisdropped)
    and not exists(select 1 from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey) and a.attname='venue_id')
    and not exists(select 1 from pg_trigger t where t.tgrelid=c.conrelid and not t.tgisinternal
      and t.tgfoid='private.enforce_reference_venue()'::regprocedure
      and t.tgname=left('venue_reference_'||(select attname from pg_attribute where attrelid=c.conrelid and attnum=c.conkey[1]),63))),
  'venue-scoped foreign key without venue consistency guard');

-- Behavioural check on one guarded reference: a venue-A deposit for a venue-B reservation.
do $$
begin
  begin
    insert into public.reservation_deposits(venue_id,reservation_id,amount_cents,expires_at)
      values('00000000-0000-4000-8000-000000000a01',(select id from sec_obj where venue='b' and kind='reservation'),1000,now()+interval '1 hour');
    raise exception 'SECURITY_PROBE_FAILED: cross-venue reservation deposit accepted';
  exception
    when check_violation then
      perform pg_temp.expect(sqlerrm='CROSS_VENUE_REFERENCE','unexpected check violation: '||sqlerrm);
    when not_null_violation then
      raise exception 'SECURITY_PROBE_FAILED: probe must supply all required deposit columns (%)',sqlerrm;
  end;
end $$;
rollback;
