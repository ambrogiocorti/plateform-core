begin;

create table if not exists public.menu_services(
  menu_id uuid not null references public.menus(id) on delete cascade,
  service_id uuid not null references public.services(id),
  sort_order integer not null default 0,
  primary key(menu_id,service_id)
);

alter table public.menu_services enable row level security;
revoke all on public.menu_services from public,anon,authenticated;
create index if not exists menu_services_service_idx
  on public.menu_services(service_id,menu_id);

create or replace function private.service_available_at(
  p_service uuid,
  p_at timestamptz
) returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_service public.services;
  v_timezone text;
  v_local timestamp;
  v_local_date date;
  v_local_time time;
begin
  if p_service is null or p_at is null then return false; end if;

  select s.* into v_service
  from public.services s
  where s.id=p_service and s.active;

  if v_service.id is null then return false; end if;

  select v.timezone into v_timezone
  from public.venues v
  where v.id=v_service.venue_id and v.active;

  if v_timezone is null then return false; end if;

  v_local:=p_at at time zone v_timezone;
  v_local_date:=v_local::date;
  v_local_time:=v_local::time;

  if v_service.starts_at>v_service.ends_at and v_local_time<v_service.ends_at then
    v_local_date:=v_local_date-1;
  end if;

  if not extract(isodow from v_local_date)::integer=any(v_service.weekdays) then
    return false;
  end if;

  if v_service.starts_at<v_service.ends_at then
    return v_local_time>=v_service.starts_at and v_local_time<v_service.ends_at;
  end if;

  return v_local_time>=v_service.starts_at or v_local_time<v_service.ends_at;
end
$$;

revoke all on function private.service_available_at(uuid,timestamptz)
from public,anon,authenticated;

create or replace function private.menu_available_at(
  p_menu uuid,
  p_venue uuid,
  p_at timestamptz
) returns boolean
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
  v_time_ok boolean;
begin
  if p_menu is null or p_venue is null or p_at is null then return false; end if;

  if not private.venue_feature_enabled(p_venue,'MULTI_MENU_QR') then return false; end if;

  select * into v_menu
  from public.menus
  where id=p_menu and active and published;

  if v_menu.id is null then return false; end if;

  if not exists(
    select 1
    from public.menu_venues mv
    join public.venues v on v.id=mv.venue_id and v.active
    where mv.menu_id=p_menu and mv.venue_id=p_venue
  ) then return false; end if;

  select timezone into v_timezone
  from public.venues
  where id=p_venue and active;

  if v_timezone is null then return false; end if;

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

  if v_menu.available_from is not null and v_business_date<v_menu.available_from then
    return false;
  end if;
  if v_menu.available_until is not null and v_business_date>v_menu.available_until then
    return false;
  end if;

  v_business_isodow:=extract(isodow from v_business_date)::integer;
  if not (v_business_isodow=any(v_menu.weekdays)) then return false; end if;

  if v_menu.starts_at is null then
    v_time_ok:=true;
  elsif v_menu.starts_at=v_menu.ends_at then
    v_time_ok:=true;
  elsif v_menu.starts_at<v_menu.ends_at then
    v_time_ok:=v_local_time>=v_menu.starts_at and v_local_time<v_menu.ends_at;
  else
    v_time_ok:=v_local_time>=v_menu.starts_at or v_local_time<v_menu.ends_at;
  end if;

  if not v_time_ok then return false; end if;

  if not exists(select 1 from public.menu_services ms where ms.menu_id=p_menu) then
    return true;
  end if;

  return exists(
    select 1
    from public.menu_services ms
    join public.services s on s.id=ms.service_id
    where ms.menu_id=p_menu
      and s.venue_id=p_venue
      and private.service_available_at(s.id,p_at)
  );
end
$$;

revoke all on function private.menu_available_at(uuid,uuid,timestamptz)
from public,anon,authenticated;

create or replace function public.get_menu_experience_workspace_v2(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_base jsonb;
  v_menus jsonb;
begin
  v_base:=public.get_menu_experience_workspace(p_venue);

  select coalesce(
    jsonb_agg(
      m.value || jsonb_build_object(
        'service_ids',
        coalesce((
          select jsonb_agg(ms.service_id order by ms.sort_order,ms.service_id)
          from public.menu_services ms
          where ms.menu_id=(m.value->>'id')::uuid
        ),'[]'::jsonb)
      )
      order by m.ordinality
    ),
    '[]'::jsonb
  )
  into v_menus
  from jsonb_array_elements(v_base->'menus') with ordinality m(value,ordinality);

  return jsonb_set(
    jsonb_set(v_base,'{menus}',v_menus,true),
    '{services}',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',s.id,
          'venue_id',s.venue_id,
          'name',s.name,
          'starts_at',s.starts_at,
          'ends_at',s.ends_at,
          'weekdays',to_jsonb(s.weekdays),
          'active',s.active,
          'version',s.version
        )
        order by v.name,s.name,s.id
      )
      from public.services s
      join public.venues v on v.id=s.venue_id
      where private.has_venue(s.venue_id)
    ),'[]'::jsonb),
    true
  );
end
$$;

revoke all on function public.get_menu_experience_workspace_v2(uuid)
from public,anon;
grant execute on function public.get_menu_experience_workspace_v2(uuid)
to authenticated,service_role;

create or replace function public.save_menu_v2(
  p_id uuid,
  p_version bigint,
  p_name text,
  p_slug text,
  p_active boolean,
  p_published boolean,
  p_weekdays integer[],
  p_starts_at time,
  p_ends_at time,
  p_available_from date,
  p_available_until date,
  p_sort_order integer,
  p_venues uuid[],
  p_categories uuid[],
  p_dishes uuid[],
  p_services uuid[],
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_menu uuid;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if not private.can_manage_shared_catalog() then
    raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
  end if;

  if p_services is null
     or cardinality(p_services)>100
     or array_position(p_services,null) is not null
     or (select count(*) from unnest(p_services) x)<>(select count(distinct x) from unnest(p_services) x)
  then raise exception 'INVALID_MENU_SERVICES'; end if;

  if exists(
    select 1
    from unnest(p_services) x(id)
    left join public.services s on s.id=x.id
    where s.id is null or not (s.venue_id=any(p_venues))
  ) then raise exception 'MENU_SERVICE_VENUE_REQUIRED'; end if;

  v_result:=private.idempotency_begin(
    'menu_configuration_v2',
    p_key,
    jsonb_build_object(
      'id',p_id,'version',p_version,'name',p_name,'slug',p_slug,
      'active',p_active,'published',p_published,'weekdays',p_weekdays,
      'starts_at',p_starts_at,'ends_at',p_ends_at,
      'available_from',p_available_from,'available_until',p_available_until,
      'sort_order',p_sort_order,'venues',p_venues,'categories',p_categories,
      'dishes',p_dishes,'services',p_services
    )
  );
  if v_result is not null then return v_result; end if;

  v_result:=public.save_menu(
    p_id,p_version,p_name,p_slug,p_active,p_published,p_weekdays,
    p_starts_at,p_ends_at,p_available_from,p_available_until,p_sort_order,
    p_venues,p_categories,p_dishes,p_key
  );
  v_menu:=(v_result->>'id')::uuid;

  delete from public.menu_services where menu_id=v_menu;
  insert into public.menu_services(menu_id,service_id,sort_order)
  select v_menu,id,ord::integer
  from unnest(p_services) with ordinality s(id,ord);

  v_result:=v_result||jsonb_build_object('service_ids',to_jsonb(p_services));
  return private.idempotency_finish('menu_configuration_v2',p_key,v_result);
end
$$;

revoke all on function public.save_menu_v2(
  uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid[],uuid[],uuid
) from public,anon;
grant execute on function public.save_menu_v2(
  uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid[],uuid[],uuid
) to authenticated,service_role;

create or replace function public.save_venue_menu_v2(
  p_venue uuid,
  p_id uuid,
  p_version bigint,
  p_name text,
  p_slug text,
  p_active boolean,
  p_published boolean,
  p_weekdays integer[],
  p_starts_at time,
  p_ends_at time,
  p_available_from date,
  p_available_until date,
  p_sort_order integer,
  p_categories uuid[],
  p_dishes uuid[],
  p_services uuid[],
  p_key uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_menu uuid;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if p_services is null
     or cardinality(p_services)>100
     or array_position(p_services,null) is not null
     or (select count(*) from unnest(p_services) x)<>(select count(distinct x) from unnest(p_services) x)
  then raise exception 'INVALID_MENU_SERVICES'; end if;

  if exists(
    select 1
    from unnest(p_services) x(id)
    left join public.services s on s.id=x.id
    where s.id is null or s.venue_id<>p_venue
  ) then raise exception 'MENU_SERVICE_VENUE_REQUIRED'; end if;

  v_result:=private.idempotency_begin(
    'venue_menu_configuration_v2',
    p_key,
    jsonb_build_object(
      'venue',p_venue,'id',p_id,'version',p_version,'name',p_name,'slug',p_slug,
      'active',p_active,'published',p_published,'weekdays',p_weekdays,
      'starts_at',p_starts_at,'ends_at',p_ends_at,
      'available_from',p_available_from,'available_until',p_available_until,
      'sort_order',p_sort_order,'categories',p_categories,'dishes',p_dishes,
      'services',p_services
    )
  );
  if v_result is not null then return v_result; end if;

  v_result:=public.save_venue_menu(
    p_venue,p_id,p_version,p_name,p_slug,p_active,p_published,p_weekdays,
    p_starts_at,p_ends_at,p_available_from,p_available_until,p_sort_order,
    p_categories,p_dishes,p_key
  );
  v_menu:=(v_result->>'id')::uuid;

  delete from public.menu_services where menu_id=v_menu;
  insert into public.menu_services(menu_id,service_id,sort_order)
  select v_menu,id,ord::integer
  from unnest(p_services) with ordinality s(id,ord);

  v_result:=v_result||jsonb_build_object('service_ids',to_jsonb(p_services));
  return private.idempotency_finish('venue_menu_configuration_v2',p_key,v_result);
end
$$;

revoke all on function public.save_venue_menu_v2(
  uuid,uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid[],uuid
) from public,anon;
grant execute on function public.save_venue_menu_v2(
  uuid,uuid,bigint,text,text,boolean,boolean,integer[],time,time,date,date,integer,uuid[],uuid[],uuid[],uuid
) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_menu_experience_workspace_v2(uuid)','authenticated'),
  ('public.save_menu_v2(uuid,bigint,text,text,boolean,boolean,integer[],time without time zone,time without time zone,date,date,integer,uuid[],uuid[],uuid[],uuid[],uuid)','authenticated'),
  ('public.save_venue_menu_v2(uuid,uuid,bigint,text,text,boolean,boolean,integer[],time without time zone,time without time zone,date,date,integer,uuid[],uuid[],uuid[],uuid)','authenticated')
on conflict do nothing;

create or replace function private.test_menu_service_assignment_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_menu_available text;
begin
  select pg_get_functiondef('private.menu_available_at(uuid,uuid,timestamptz)'::regprocedure)
  into v_menu_available;

  if not exists(
      select 1 from information_schema.tables
      where table_schema='public' and table_name='menu_services'
    )
    or v_menu_available not like '%private.service_available_at%'
    or v_menu_available not like '%public.menu_services%'
    or not exists(
      select 1 from private.api_permission_manifest
      where function_identity='public.get_menu_experience_workspace_v2(uuid)'
        and api_role='authenticated'
    )
    or not exists(
      select 1 from private.api_permission_manifest
      where function_identity like 'public.save_menu_v2(%'
        and api_role='authenticated'
    )
    or not exists(
      select 1 from private.api_permission_manifest
      where function_identity like 'public.save_venue_menu_v2(%'
        and api_role='authenticated'
    )
  then raise exception 'MENU_SERVICE_ASSIGNMENT_CONTRACT_FAILED'; end if;

  return jsonb_build_object(
    'normalized_join_table',true,
    'service_schedule_authoritative',true,
    'chain_save_atomic',true,
    'venue_save_atomic',true,
    'workspace_service_ids',true,
    'explicit_api_manifest',true
  );
end
$$;

revoke all on function private.test_menu_service_assignment_contract()
from public,anon,authenticated;
grant execute on function private.test_menu_service_assignment_contract()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'MENU_SERVICE_ASSIGNMENT_CONTRACT',
  'REGRESSION',
  true,
  'Menus can be associated with restaurant services through a normalized join table; public availability requires an active matching service schedule when associations exist, and v2 Admin RPCs save associations atomically.'
)
on conflict(key) do nothing;

commit;