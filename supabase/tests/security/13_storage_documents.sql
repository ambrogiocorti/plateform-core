-- Storage metadata RLS as evaluated by the Storage API (storage.objects).
-- Private 'documents' must follow venue + ADMIN scope; public image buckets
-- are readable by design; no API role may write objects directly.
begin;
\ir _seed.sql
insert into storage.objects(bucket_id,name) values('gallery','venue-a/sala.webp');
insert into public.asset_uploads(actor_id,venue_id,bucket,path,size_bytes,mime,status)
  select id,null,'documents','chain/listino.pdf',100,'application/pdf','SAVED' from sec_actor where name='chain_admin';
insert into storage.objects(bucket_id,name) values('documents','chain/listino.pdf'),('documents','orphan/not-registered.pdf');

create temp table sec_storage(actor text, expected text[]) on commit drop;
insert into sec_storage values
  ('admin_a',array['venue-a/contratto.pdf']),
  ('admin_b',array['venue-b/contratto.pdf']),
  ('chain_admin',array['chain/listino.pdf','venue-a/contratto.pdf','venue-b/contratto.pdf']),
  ('waiter_a','{}'),('host_a','{}'),('cashier_a','{}'),('kadmin_a','{}'),('kstaff_a','{}'),('pass_a','{}'),
  ('super','{}'),('outsider','{}'),('anon','{}');

do $$
declare e record; seen text[];
begin
  for e in select * from sec_storage loop
    perform pg_temp.act(e.actor);
    select coalesce(array_agg(name order by name),'{}') into seen from storage.objects where bucket_id='documents';
    execute 'reset role';
    perform pg_temp.expect(seen=e.expected, format('%s reads documents %s, expected %s',e.actor,seen,e.expected));
    perform pg_temp.act(e.actor);
    perform pg_temp.expect((select count(*) from storage.objects where bucket_id='gallery')=1, format('%s cannot read public gallery',e.actor));
    execute 'reset role';
  end loop;
end $$;

-- Bucket hardening.
select pg_temp.expect(not public,'documents bucket must be private') from storage.buckets where id='documents';
select pg_temp.expect(not exists(select 1 from pg_policies where schemaname='storage' and cmd<>'SELECT'
  and roles && array['anon','authenticated','public']::name[]),'API roles have a write policy on storage');
rollback;
