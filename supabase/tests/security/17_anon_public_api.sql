-- Public (anon) API: only the reviewed read-only site/menu/booking entry points,
-- no personal data, nothing from an inactive venue, and no direct table access
-- beyond PUBLIC invalidation signals.
begin;
\ir _seed.sql
update public.venues set active=false where id='00000000-0000-4000-8000-000000000b01';

select pg_temp.expect(array_agg(p.proname::text order by p.proname) <@ array[
  'get_booking_configuration','get_public_booking_availability','get_public_menu','get_public_menu_by_id',
  'get_public_menu_by_slug','get_public_menu_index','get_public_navigation','get_public_page_metadata',
  'get_public_site','get_public_sitemap_entries'],
  'unreviewed function executable by anon: '||array_agg(p.proname::text order by p.proname)::text)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and has_function_privilege('anon',p.oid,'execute');

select pg_temp.expect(not p.provolatile='v','anon function is VOLATILE (may write): '||p.oid::regprocedure::text)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and has_function_privilege('anon',p.oid,'execute');

do $$
declare call text; r text; v text;
begin
  foreach v in array array['00000000-0000-4000-8000-000000000a01','00000000-0000-4000-8000-000000000b01'] loop
    foreach call in array array[
      'public.get_public_site()','public.get_public_sitemap_entries()',
      format('public.get_public_menu(%L)',v),format('public.get_public_menu_index(%L)',v),
      format('public.get_public_navigation(%L)',v),format('public.get_booking_configuration(%L)',v),
      format('public.get_public_booking_availability(%L,%L,current_date+1,2)',v,(select id from sec_obj where kind='service' and venue=case when v like '%a01' then 'a' else 'b' end))] loop
      perform pg_temp.act('anon');
      begin
        execute format('select (%s)::text',call) into r;
      exception when others then r:=null;
      end;
      execute 'reset role';
      perform pg_temp.expect(coalesce(r,'') !~* '(Cliente [ab]|\+3933300000|@staff\.test|contratto\.pdf)', format('anon %s exposes personal/private data',call));
      perform pg_temp.expect(coalesce(r,'') !~* '000000000b01', format('anon %s exposes inactive venue B',call));
      perform pg_temp.expect(coalesce(r,'') !~* (select string_agg(id::text,'|') from sec_obj where kind in ('account','order','payment','reservation','notification','call','upload')),
        format('anon %s exposes internal operational ids',call));
    end loop;
  end loop;
end $$;
rollback;
