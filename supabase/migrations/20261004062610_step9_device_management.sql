begin;

create or replace function private.device_assignment_label(p_user uuid,p_venue uuid)
returns text
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  role_name public.user_role;
  station_names text;
begin
  select role into role_name
    from public.staff_profiles
   where id=p_user;

  select string_agg(s.name, ', ' order by s.name)
    into station_names
    from public.station_staff_assignments a
    join public.stations s on s.id=a.station_id and s.venue_id=a.venue_id
   where a.user_id=p_user
     and a.venue_id=p_venue
     and a.active
     and s.active;

  if station_names is not null then
    return 'STATION: '||station_names;
  end if;
  return role_name::text;
end $$;

revoke all on function private.device_assignment_label(uuid,uuid) from public,anon,authenticated;

create or replace function private.fill_registered_device_assignment()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  new.assigned_role_or_station:=private.device_assignment_label(new.user_id,new.venue_id);
  return new;
end $$;

drop trigger if exists fill_registered_device_assignment on public.registered_devices;
create trigger fill_registered_device_assignment
before insert or update of user_id,venue_id on public.registered_devices
for each row execute function private.fill_registered_device_assignment();

create or replace function public.heartbeat_device()
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  device uuid;
  seen_at timestamptz:=clock_timestamp();
begin
  perform private.authorize(
    null,
    array['SUPER_ADMIN','ADMIN','HOST','WAITER','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[],
    false
  );

  select device_id into device
    from private.staff_sessions
   where session_id=private.jwt_session_id()
     and user_id=auth.uid()
     and revoked_at is null;

  if device is null then return false; end if;

  update public.registered_devices d
     set last_seen_at=seen_at,
         assigned_role_or_station=private.device_assignment_label(d.user_id,d.venue_id)
   where d.id=device
     and d.revoked_at is null;

  if not found then return false; end if;

  insert into private.device_heartbeats(device_id,last_seen_at)
  values(device,seen_at)
  on conflict(device_id) do update set last_seen_at=excluded.last_seen_at;

  return true;
end $$;

create or replace function private.touch_device_offline_sync()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.device_id is not null
     and new.sync_status in ('SYNCED','CONFLICT')
     and (tg_op='INSERT' or old.sync_status is distinct from new.sync_status or old.synced_at is distinct from new.synced_at) then
    update public.registered_devices d
       set last_sync_at=coalesce(new.synced_at,clock_timestamp()),
           last_seen_at=greatest(d.last_seen_at,coalesce(new.synced_at,clock_timestamp())),
           assigned_role_or_station=private.device_assignment_label(d.user_id,d.venue_id)
     where d.id=new.device_id
       and d.revoked_at is null;
  end if;
  return new;
end $$;

drop trigger if exists touch_device_offline_sync on public.offline_sync_events;
create trigger touch_device_offline_sync
after insert or update of sync_status,synced_at on public.offline_sync_events
for each row execute function private.touch_device_offline_sync();

create or replace function public.get_device_management(p_venue uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  role_name public.user_role:=private.real_role();
  scope_name public.user_scope:=private.current_scope();
  result jsonb;
begin
  if role_name is null
     or private.impersonation_id() is not null
     or role_name not in ('ADMIN','SUPER_ADMIN') then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  if role_name='ADMIN' then
    if p_venue is null and scope_name<>'CHAIN' then
      raise exception 'CHAIN_SCOPE_REQUIRED';
    end if;
    if p_venue is not null and not private.has_venue(p_venue) then
      raise exception 'VENUE_FORBIDDEN' using errcode='42501';
    end if;
  elsif p_venue is not null and not exists(select 1 from public.venues v where v.id=p_venue) then
    raise exception 'NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',d.id,
      'display_name',d.display_name,
      'platform',d.platform,
      'venue_id',d.venue_id,
      'venue_name',v.name,
      'user_id',d.user_id,
      'user_name',p.display_name,
      'user_role',p.role,
      'user_active',p.active,
      'assigned_role_or_station',coalesce(private.device_assignment_label(d.user_id,d.venue_id),d.assigned_role_or_station),
      'app_version',d.app_version,
      'last_seen_at',greatest(d.last_seen_at,h.last_seen_at),
      'last_sync_at',d.last_sync_at,
      'revoked_at',d.revoked_at,
      'online',d.revoked_at is null and greatest(d.last_seen_at,h.last_seen_at)>now()-interval '5 minutes',
      'current',exists(
        select 1 from private.staff_sessions s
         where s.session_id=private.jwt_session_id()
           and s.user_id=auth.uid()
           and s.device_id=d.id
           and s.revoked_at is null
      ),
      'can_revoke',d.revoked_at is null and (d.user_id=auth.uid() or private.can_manage_staff(d.user_id))
    )
    order by (d.revoked_at is not null),greatest(d.last_seen_at,h.last_seen_at) desc,d.display_name,d.id
  ),'[]'::jsonb)
  into result
  from public.registered_devices d
  join public.staff_profiles p on p.id=d.user_id
  join public.venues v on v.id=d.venue_id
  left join private.device_heartbeats h on h.device_id=d.id
  where
    (p_venue is null or d.venue_id=p_venue)
    and (
      role_name='SUPER_ADMIN'
      or (role_name='ADMIN' and private.has_venue(d.venue_id))
    );

  return jsonb_build_object('devices',result);
end $$;

revoke all on function public.get_device_management(uuid) from public,anon;
grant execute on function public.get_device_management(uuid) to authenticated;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_device_management(uuid)','authenticated')
on conflict do nothing;

commit;