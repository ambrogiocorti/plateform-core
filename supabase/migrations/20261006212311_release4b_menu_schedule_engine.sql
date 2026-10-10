
create or replace function private.menu_available_at(
  p_menu uuid,
  p_venue uuid,
  p_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_menu public.menus;
  v_timezone text;
  v_local timestamp;
  v_business_date date;
  v_local_time time;
  v_business_isodow integer;
begin
  if p_menu is null or p_venue is null or p_at is null then
    return false;
  end if;

  select * into v_menu
  from public.menus
  where id=p_menu
    and active
    and published;

  if v_menu.id is null then
    return false;
  end if;

  if not exists(
    select 1
    from public.menu_venues mv
    join public.venues v on v.id=mv.venue_id and v.active
    where mv.menu_id=p_menu
      and mv.venue_id=p_venue
  ) then
    return false;
  end if;

  select timezone into v_timezone
  from public.venues
  where id=p_venue and active;

  if v_timezone is null then
    return false;
  end if;

  v_local:=p_at at time zone v_timezone;
  v_local_time:=v_local::time;
  v_business_date:=v_local::date;

  if v_menu.starts_at is not null
     and v_menu.ends_at is not null
     and v_menu.starts_at>v_menu.ends_at
     and v_local_time<v_menu.ends_at
  then
    v_business_date:=v_business_date-1;
  end if;

  if v_menu.available_from is not null
     and v_business_date<v_menu.available_from then
    return false;
  end if;

  if v_menu.available_until is not null
     and v_business_date>v_menu.available_until then
    return false;
  end if;

  v_business_isodow:=extract(isodow from v_business_date)::integer;

  if not (v_business_isodow=any(v_menu.weekdays)) then
    return false;
  end if;

  if v_menu.starts_at is null then
    return true;
  end if;

  if v_menu.starts_at=v_menu.ends_at then
    return true;
  elsif v_menu.starts_at<v_menu.ends_at then
    return v_local_time>=v_menu.starts_at
       and v_local_time<v_menu.ends_at;
  else
    return v_local_time>=v_menu.starts_at
       or v_local_time<v_menu.ends_at;
  end if;
end
$$;

revoke all on function private.menu_available_at(uuid,uuid,timestamptz)
from public,anon,authenticated;
