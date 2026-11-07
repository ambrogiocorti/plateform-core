
create or replace function public.search_operational_resources(
  p_query text,
  p_venue uuid default null
)
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
  if role_name is null
     or p_query is null
     or length(trim(p_query)) not between 2 and 100
  then
    return '[]'::jsonb;
  end if;

  if role_name<>'SUPER_ADMIN'
     and (
       p_venue is null
       or not private.has_venue(p_venue)
     )
  then
    return '[]'::jsonb;
  end if;

  if role_name='SUPER_ADMIN'
     and p_venue is not null
     and not private.has_venue(p_venue)
  then
    return '[]'::jsonb;
  end if;

  pattern:='%'||
    replace(
      replace(
        replace(trim(p_query),'\','\\'),
        '%','\%'
      ),
      '_','\_'
    )||'%';

  select coalesce(
    jsonb_agg(to_jsonb(hit) order by hit.kind,hit.label),
    '[]'::jsonb
  )
  into result
  from (
    (
      select
        'TABLE'::text kind,
        t.id,
        t.name label,
        '/staff/sala?tavolo='||t.id::text path,
        t.venue_id
      from public.tables t
      where role_name in (
        'SUPER_ADMIN','ADMIN','HOST','WAITER','CASHIER','PASS'
      )
        and t.active
        and (p_venue is null or t.venue_id=p_venue)
        and (
          t.name ilike pattern escape '\'
          or t.number::text ilike pattern escape '\'
        )
      limit 10
    )
    union all
    (
      select
        'ACCOUNT',
        a.id,
        a.account_name,
        '/staff/conti/'||a.id::text,
        a.venue_id
      from public.accounts a
      where role_name in ('SUPER_ADMIN','ADMIN','WAITER','CASHIER')
        and (p_venue is null or a.venue_id=p_venue)
        and a.account_name ilike pattern escape '\'
      order by a.created_at desc
      limit 10
    )
    union all
    (
      select
        'RESERVATION',
        r.id,
        trim(r.first_name||coalesce(' '||r.last_name,'')),
        '/staff/accoglienza?prenotazione='||r.id::text,
        r.venue_id
      from public.reservations r
      where role_name in ('SUPER_ADMIN','ADMIN','HOST')
        and (p_venue is null or r.venue_id=p_venue)
        and (
          trim(r.first_name||coalesce(' '||r.last_name,'')) ilike pattern escape '\'
          or r.phone ilike pattern escape '\'
        )
      order by r.service_date desc,r.slot_time desc
      limit 10
    )
    union all
    (
      select
        'DISH',
        d.id,
        d.name,
        '/staff/gestione?modulo=dishes&elemento='||d.id::text,
        null::uuid
      from public.dishes d
      where role_name in ('SUPER_ADMIN','ADMIN')
        and d.active
        and d.name ilike pattern escape '\'
      order by d.name
      limit 10
    )
    union all
    (
      select
        'STAFF',
        s.id,
        s.display_name,
        '/staff/utenti?utente='||s.id::text,
        null::uuid
      from public.staff_profiles s
      where role_name in ('SUPER_ADMIN','ADMIN')
        and s.active
        and s.display_name ilike pattern escape '\'
      order by s.display_name
      limit 10
    )
    union all
    (
      select
        'REGISTER',
        c.id,
        c.name,
        '/staff/cassa?postazione='||c.id::text,
        c.venue_id
      from public.cash_registers c
      where role_name in ('SUPER_ADMIN','ADMIN','CASHIER')
        and c.active
        and (p_venue is null or c.venue_id=p_venue)
        and (
          c.name ilike pattern escape '\'
          or c.code ilike pattern escape '\'
        )
      order by c.name
      limit 10
    )
    union all
    (
      select
        'VENUE',
        v.id,
        v.name,
        '/staff/sala?sede='||v.id::text,
        v.id
      from public.venues v
      where role_name in (
        'SUPER_ADMIN','ADMIN','HOST','WAITER','CASHIER','PASS'
      )
        and v.active
        and (p_venue is null or v.id=p_venue)
        and v.name ilike pattern escape '\'
      order by v.name
      limit 10
    )
    union all
    (
      select
        'SETTINGS',
        p_venue,
        'Impostazioni',
        case
          when role_name='SUPER_ADMIN' and p_venue is null
            then '/staff/superadmin/impostazioni'
          else '/staff/impostazioni?sede='||p_venue::text
        end,
        p_venue
      where role_name in ('SUPER_ADMIN','ADMIN')
        and (
          'Impostazioni' ilike pattern escape '\'
          or 'Settings' ilike pattern escape '\'
        )
    )
  ) hit;

  return result;
end
$$;

revoke all on function public.search_operational_resources(text,uuid)
from public,anon;
grant execute on function public.search_operational_resources(text,uuid)
to authenticated,service_role;

insert into private.release_test_catalog(key,category,required,description)
values(
  'COMMAND_PALETTE_STAFF_PATH_NAMESPACE',
  'REGRESSION',
  true,
  'All operational Command Palette navigation paths are internal /staff paths; clients reject any returned path outside the staff namespace.'
)
on conflict(key) do nothing;
