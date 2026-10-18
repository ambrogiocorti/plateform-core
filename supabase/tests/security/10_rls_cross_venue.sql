-- Cross-venue, cross-role and outsider isolation of every API-readable table.
-- One Plateform installation serves one client (no shared multi-tenant DB), so
-- "cross-tenant" means: an authenticated user without an active staff profile
-- of this installation, or the anon key, must read nothing private.
begin;
\ir _seed.sql

do $$
declare a record; t record; n bigint; visible_own bigint;
begin
  -- Venue-scoped staff never read rows of a venue they are not assigned to.
  for a in select * from sec_actor where scope='VENUE' loop
    for t in select c.relname from pg_class c join pg_namespace s on s.oid=c.relnamespace
      join pg_attribute att on att.attrelid=c.oid and att.attname='venue_id' and not att.attisdropped
      where s.nspname='public' and c.relkind in ('r','p','v') and not c.relispartition
        and has_table_privilege('authenticated',c.oid,'select') order by 1 loop
      perform pg_temp.act(a.name);
      execute format('select count(*) from public.%I where venue_id is distinct from $1 and venue_id is not null%s',t.relname,
        -- PUBLIC realtime signals only carry an active venue id (invalidation), by design.
        case when t.relname='realtime_signals' then ' and topic<>''PUBLIC''' else '' end) into n using a.venue;
      execute 'reset role';
      perform pg_temp.expect(n=0, format('%s reads %s rows of another venue in %s',a.name,n,t.relname));
    end loop;
  end loop;

  -- Outsider (valid JWT and Auth session, no staff profile) and anon read nothing,
  -- except anon's PUBLIC realtime topic.
  for t in select c.relname from pg_class c join pg_namespace s on s.oid=c.relnamespace
    where s.nspname='public' and c.relkind in ('r','p','v') and not c.relispartition
      and has_table_privilege('authenticated',c.oid,'select') order by 1 loop
    perform pg_temp.act('outsider');
    execute format('select count(*) from public.%I%s',t.relname,
      case when t.relname='realtime_signals' then ' where topic<>''PUBLIC''' else '' end) into n;
    execute 'reset role';
    perform pg_temp.expect(n=0, format('outsider reads %s rows of %s',n,t.relname));
    if has_table_privilege('anon',format('public.%I',t.relname),'select') then
      perform pg_temp.act('anon');
      execute format('select count(*) from public.%I where %s',t.relname,
        case when t.relname='realtime_signals' then 'topic<>''PUBLIC''' else 'true' end) into n;
      execute 'reset role';
      perform pg_temp.expect(n=0, format('anon reads %s private rows of %s',n,t.relname));
    end if;
  end loop;

  -- Partitions (audit) must not be reachable directly by API roles.
  perform pg_temp.expect(not exists(select 1 from pg_class c join pg_namespace s on s.oid=c.relnamespace
    where s.nspname='public' and c.relispartition
      and (has_table_privilege('anon',c.oid,'select,insert,update,delete')
        or has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))),
    'a public partition is directly reachable by anon/authenticated');

  -- Non-vacuous: the same probes see their own venue and the chain admin sees both.
  perform pg_temp.act('admin_a');
  select count(*) into visible_own from public.accounts;
  execute 'reset role';
  perform pg_temp.expect(visible_own=1, format('admin_a should read exactly its own account, got %s',visible_own));
  perform pg_temp.act('chain_admin');
  select count(*) into n from public.accounts;
  execute 'reset role';
  perform pg_temp.expect(n=2, format('chain admin should read both venues, got %s',n));
end $$;
rollback;
