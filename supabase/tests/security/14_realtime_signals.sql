-- Realtime postgres_changes delivers a row only if the subscriber passes the
-- table's RLS: verify topic visibility per role, venue and customer session.
begin;
\ir _seed.sql

create temp table sec_topics(actor text, topics text[]) on commit drop;
insert into sec_topics values
  ('admin_a',array['ACCOUNT','BOOKING','CALL','CONFIG','FINANCE','FLOOR','KITCHEN','NOTIFICATION']),
  ('host_a',array['BOOKING','FLOOR']),
  ('waiter_a',array['ACCOUNT','CALL','FLOOR','KITCHEN']),
  ('cashier_a',array['ACCOUNT','FINANCE','FLOOR']),
  ('kadmin_a',array['KITCHEN']),
  ('kstaff_a','{}'),
  ('pass_a',array['FLOOR','KITCHEN']),
  ('super','{}'),
  ('outsider','{}'),
  ('anon','{}');

do $$
declare e record; seen text[]; other bigint;
begin
  for e in select * from sec_topics loop
    perform pg_temp.act(e.actor);
    select coalesce(array_agg(distinct topic order by topic),'{}') into seen from public.realtime_signals
      where topic not in ('PUBLIC','ACCESS') and venue_id='00000000-0000-4000-8000-000000000a01';
    select count(*) into other from public.realtime_signals where topic<>'PUBLIC' and venue_id='00000000-0000-4000-8000-000000000b01';
    execute 'reset role';
    perform pg_temp.expect(seen=e.topics, format('%s sees topics %s, expected %s',e.actor,seen,e.topics));
    perform pg_temp.expect(other=0, format('%s sees %s private signals of venue B',e.actor,other));
  end loop;
end $$;

-- ACCESS signals reach only their recipient (seed triggers emit one per staff member).
do $$
declare a record; own bigint; foreign_rows bigint;
begin
  for a in select * from sec_actor loop
    perform pg_temp.act(a.name);
    select count(*) filter(where recipient_user_id=a.id),count(*) filter(where recipient_user_id is distinct from a.id)
      into own,foreign_rows from public.realtime_signals where topic='ACCESS';
    execute 'reset role';
    perform pg_temp.expect(foreign_rows=0, format('%s reads %s ACCESS signals of other users',a.name,foreign_rows));
    perform pg_temp.expect(a.role is null or own>0, format('%s cannot read its own ACCESS signals',a.name));
  end loop;
end $$;

-- Only the reviewed invalidation table is published.
select pg_temp.expect(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
  and (schemaname,tablename)<>('public','realtime_signals')),'unreviewed table in supabase_realtime publication');
rollback;
