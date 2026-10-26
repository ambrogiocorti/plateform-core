begin;
create table private.device_registration_secrets (
  device_id uuid primary key references public.registered_devices(id),
  token_hash bytea not null check(octet_length(token_hash)=32),
  created_at timestamptz not null default now()
);
revoke all on private.device_registration_secrets from public,anon,authenticated;

drop function public.complete_staff_login(text,text,text);
create function public.complete_staff_login(p_device_name text,p_platform text,p_app_version text,p_device uuid default null,p_device_token text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role:=private.authenticated_role(); existing private.staff_sessions; device uuid; venue uuid;
  full_auth timestamptz:=private.password_authenticated_at(); expiry timestamptz; registered public.registered_devices;
begin
  if role_name is null or (not private.installation_active() and role_name<>'SUPER_ADMIN') then raise exception 'LOGIN_FORBIDDEN' using errcode='42501'; end if;
  if p_device_name is null or length(p_device_name) not between 1 and 100 or p_platform is null or length(p_platform)>100 or p_app_version is null or length(p_app_version)>50 then raise exception 'INVALID_DEVICE'; end if;
  expiry:=full_auth+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120));
  if full_auth is null or expiry<=now() then raise exception 'FULL_AUTH_REQUIRED' using errcode='42501'; end if;
  -- Serialize simultaneous tabs for the same identity and registration.
  perform 1 from public.staff_profiles where id=auth.uid() for update;
  select * into existing from private.staff_sessions where session_id=private.jwt_session_id() for update;
  if existing.session_id is not null then
    if existing.revoked_at is not null or existing.unlocked_until<=now() then raise exception 'PIN_OR_FULL_AUTH_REQUIRED' using errcode='42501'; end if;
    if existing.device_id is not null and exists(select 1 from public.registered_devices where id=existing.device_id and revoked_at is not null) then raise exception 'DEVICE_REVOKED' using errcode='42501'; end if;
    return jsonb_build_object('device_id',existing.device_id,'expires_at',existing.unlocked_until);
  end if;
  select v.id into venue from public.venues v where v.active and
    (exists(select 1 from public.staff_profiles p where p.id=auth.uid() and p.scope='CHAIN') or
     exists(select 1 from public.staff_venue_assignments a where a.user_id=auth.uid() and a.venue_id=v.id and a.active)) order by v.name limit 1;
  if venue is not null then
    if p_device_token is null or p_device_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'INVALID_DEVICE_TOKEN'; end if;
    if p_device is not null then
      select * into registered from public.registered_devices where id=p_device and user_id=auth.uid() for update;
      if registered.id is null or not exists(select 1 from private.device_registration_secrets where device_id=p_device and token_hash=extensions.digest(p_device_token,'sha256')) then raise exception 'INVALID_DEVICE_TOKEN' using errcode='42501'; end if;
      if registered.revoked_at is not null then raise exception 'DEVICE_REVOKED' using errcode='42501'; end if;
      device:=registered.id;
      update public.registered_devices set venue_id=venue,display_name=p_device_name,platform=p_platform,app_version=p_app_version,last_seen_at=now() where id=device;
    else
      perform 1 from public.system_limits where id for update;
      if (select count(*) from public.registered_devices where revoked_at is null)>=(select max_devices from public.system_limits where id) then raise exception 'DEVICE_LIMIT'; end if;
      insert into public.registered_devices(user_id,venue_id,display_name,platform,app_version) values(auth.uid(),venue,p_device_name,p_platform,p_app_version) returning id into device;
      insert into private.device_registration_secrets(device_id,token_hash) values(device,extensions.digest(p_device_token,'sha256'));
    end if;
  elsif role_name<>'SUPER_ADMIN' then raise exception 'VENUE_ASSIGNMENT_REQUIRED'; end if;
  insert into private.staff_sessions(session_id,user_id,device_id,full_auth_at,unlocked_until) values(private.jwt_session_id(),auth.uid(),device,full_auth,expiry);
  update private.staff_pins set failed_attempts=0,locked_until=null where user_id=auth.uid();
  perform private.audit('AUTH_LOGIN','staff_profiles',auth.uid(),venue);
  return jsonb_build_object('device_id',device,'expires_at',expiry);
end $$;

create or replace function public.get_auth_requirements() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('role',p.role,'display_name',p.display_name,'active',p.active,
    'mfa_required',p.role='SUPER_ADMIN' or (p.role='ADMIN' and coalesce((select admin_mfa_required from public.restaurant_settings where id),true))
      or (p.role='CASHIER' and coalesce((select cashier_mfa_required from public.restaurant_settings where id),false)),
    'installation_active',private.installation_active(), 'setup_required',not exists(select 1 from public.restaurant_profile),
    'session_unlocked',private.real_role() is not null,
    'pin_enabled',exists(select 1 from private.staff_pins where user_id=p.id),
    'password_required',coalesce(not p.active or private.authenticated_role() is null or s.revoked_at is not null or s.session_id is null or pin.failed_attempts>=5
      or private.password_authenticated_at() is null
      or private.password_authenticated_at()+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120))<=now()
      or exists(select 1 from public.registered_devices where id=s.device_id and revoked_at is not null),false),
    'full_auth_expires_at',private.password_authenticated_at()+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120)),
    'retry_after_seconds',greatest(0,ceil(extract(epoch from pin.locked_until-now())))::integer)
  from public.staff_profiles p left join private.staff_sessions s on s.session_id=private.jwt_session_id() and s.user_id=p.id
    left join private.staff_pins pin on pin.user_id=p.id
  where p.id=auth.uid() and exists(select 1 from auth.sessions a where a.id=private.jwt_session_id() and a.user_id=p.id)
$$;

create or replace function public.unlock_staff_session(p_pin text) returns jsonb language plpgsql security definer set search_path='' as $$
declare pin private.staff_pins; session private.staff_sessions; expiry timestamptz;
begin
  if private.authenticated_role() is null or (not private.installation_active() and private.authenticated_role()<>'SUPER_ADMIN') then return jsonb_build_object('ok',false,'password_required',true); end if;
  select * into session from private.staff_sessions where session_id=private.jwt_session_id() and user_id=auth.uid() and revoked_at is null for update;
  expiry:=session.full_auth_at+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120));
  if session.session_id is null or expiry<=now() or exists(select 1 from public.registered_devices where id=session.device_id and revoked_at is not null) then return jsonb_build_object('ok',false,'password_required',true); end if;
  select * into pin from private.staff_pins where user_id=auth.uid() for update;
  if pin.user_id is null then return jsonb_build_object('ok',false,'password_required',true); end if;
  if pin.failed_attempts>=5 or pin.locked_until>now() then return jsonb_build_object('ok',false,'password_required',pin.failed_attempts>=5); end if;
  if p_pin is null or p_pin !~ '^[0-9]{6,10}$' or extensions.crypt(p_pin,pin.pin_hash) is distinct from pin.pin_hash then
    update private.staff_pins set failed_attempts=failed_attempts+1,locked_until=now()+make_interval(secs=>power(2,pin.failed_attempts)::integer) where user_id=auth.uid();
    perform private.audit('PIN_FAILED','staff_profiles',auth.uid(),null,null,null,'DENIED');
    return jsonb_build_object('ok',false,'password_required',pin.failed_attempts+1>=5);
  end if;
  update private.staff_pins set failed_attempts=0,locked_until=null where user_id=auth.uid();
  update private.staff_sessions set unlocked_until=expiry where session_id=session.session_id;
  perform private.audit('PIN_UNLOCKED','staff_profiles',auth.uid(),null);
  return jsonb_build_object('ok',true,'expires_at',expiry);
end $$;

create function public.reset_staff_pin(p_user uuid,p_grant uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.can_manage_staff(p_user) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform private.authorize(null,array['ADMIN','SUPER_ADMIN']::public.user_role[]);
  perform private.consume_step_up(p_grant,case when private.current_role()='SUPER_ADMIN' then 'PRIVILEGED_STAFF' else 'STAFF_CHANGE' end,p_user);
  delete from private.staff_pins where user_id=p_user;
  update private.staff_sessions set unlocked_until=now() where user_id=p_user;
  update public.offline_authorization_snapshots set revoked_at=now() where user_id=p_user and revoked_at is null;
  perform private.audit('PIN_RESET','staff_profiles',p_user,null);
end $$;
grant execute on function public.complete_staff_login(text,text,text,uuid,text),public.reset_staff_pin(uuid,uuid) to authenticated;
commit;
