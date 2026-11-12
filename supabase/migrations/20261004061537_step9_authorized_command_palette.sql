create or replace function public.search_operational_resources(p_query text,p_venue uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  pattern text;
  result jsonb;
  role_name public.user_role:=private.current_role();
begin
  if role_name is null or p_query is null or length(trim(p_query)) not between 2 and 100 then
    return '[]'::jsonb;
  end if;

  pattern:='%'||replace(replace(replace(trim(p_query),'\','\\'),'%','\%'),'_','\_')||'%';

  select coalesce(jsonb_agg(to_jsonb(hit) order by hit.kind,hit.label),'[]') into result
  from (
    (select 'TABLE'::text kind,t.id,t.name label,'/sala?tavolo='||t.id::text path,t.venue_id
       from public.tables t
      where role_name in ('ADMIN','HOST','WAITER','CASHIER','PASS')
        and t.active
        and (p_venue is null or t.venue_id=p_venue)
        and (t.name ilike pattern or t.number::text ilike pattern)
      limit 10)
    union all
    (select 'ACCOUNT',a.id,a.account_name,'/conti/'||a.id::text,a.venue_id
       from public.accounts a
      where role_name in ('ADMIN','WAITER','CASHIER')
        and (p_venue is null or a.venue_id=p_venue)
        and a.account_name ilike pattern
      order by a.created_at desc
      limit 10)
    union all
    (select 'RESERVATION',r.id,r.first_name||coalesce(' '||r.last_name,''),'/accoglienza?prenotazione='||r.id::text,r.venue_id
       from public.reservations r
      where role_name in ('ADMIN','HOST')
        and (p_venue is null or r.venue_id=p_venue)
        and (r.first_name||coalesce(' '||r.last_name,'') ilike pattern or r.phone ilike pattern)
      order by r.service_date desc
      limit 10)
    union all
    (select 'DISH',d.id,d.name,'/gestione?modulo=dishes&elemento='||d.id::text,null::uuid
       from public.dishes d
      where role_name='ADMIN'
        and d.active
        and d.name ilike pattern
      order by d.name
      limit 10)
    union all
    (select 'STAFF',s.id,s.display_name,'/staff?utente='||s.id::text,null::uuid
       from public.staff_profiles s
      where role_name in ('ADMIN','SUPER_ADMIN')
        and s.active
        and s.display_name ilike pattern
      order by s.display_name
      limit 10)
    union all
    (select 'REGISTER',c.id,c.name,'/cassa?postazione='||c.id::text,c.venue_id
       from public.cash_registers c
      where role_name in ('ADMIN','CASHIER')
        and c.active
        and (p_venue is null or c.venue_id=p_venue)
        and (c.name ilike pattern or c.code ilike pattern)
      order by c.name
      limit 10)
    union all
    (select 'VENUE',v.id,v.name,'/sala?sede='||v.id::text,v.id
       from public.venues v
      where role_name in ('ADMIN','HOST','WAITER','CASHIER','PASS')
        and v.active
        and (p_venue is null or v.id=p_venue)
        and v.name ilike pattern
      order by v.name
      limit 10)
  ) hit;

  return result;
end $$;