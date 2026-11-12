begin;
create function private.authenticated_role() returns public.user_role language sql stable security definer set search_path='' as $$
  select p.role from public.staff_profiles p where p.id=auth.uid() and p.active
    and exists(select 1 from auth.sessions s where s.id=private.jwt_session_id() and s.user_id=p.id)
    and to_timestamp(coalesce((auth.jwt()->>'iat')::double precision,0))>=p.auth_valid_after
    and (p.role<>'SUPER_ADMIN' or auth.jwt()->>'aal'='aal2')
    and (p.role<>'ADMIN' or not coalesce((select admin_mfa_required from public.restaurant_settings where id),true) or auth.jwt()->>'aal'='aal2')
    and (p.role<>'CASHIER' or not coalesce((select cashier_mfa_required from public.restaurant_settings where id),false) or auth.jwt()->>'aal'='aal2')
$$;
create function private.password_authenticated_at() returns timestamptz language sql stable set search_path='' as $$
  select max(to_timestamp((amr->>'timestamp')::double precision)) from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]')) amr
    where amr->>'method'='password'
$$;
create or replace function private.real_role() returns public.user_role language sql stable security definer set search_path='' as $$
  select private.authenticated_role() where private.password_authenticated_at() > now()-make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120))
    and (
      (not exists(select 1 from public.restaurant_profile) and private.authenticated_role()='SUPER_ADMIN')
      or exists(select 1 from private.staff_sessions s where s.session_id=private.jwt_session_id() and s.user_id=auth.uid()
        and s.revoked_at is null and s.unlocked_until>now()
        and (s.device_id is null or exists(select 1 from public.registered_devices d where d.id=s.device_id and d.user_id=auth.uid() and d.revoked_at is null)))
    )
$$;

create function public.get_auth_requirements() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('role',p.role,'display_name',p.display_name,'active',p.active,
    'mfa_required',p.role='SUPER_ADMIN' or (p.role='ADMIN' and coalesce((select admin_mfa_required from public.restaurant_settings where id),true))
      or (p.role='CASHIER' and coalesce((select cashier_mfa_required from public.restaurant_settings where id),false)),
    'installation_active',private.installation_active(), 'setup_required',not exists(select 1 from public.restaurant_profile),
    'session_unlocked',private.real_role() is not null)
  from public.staff_profiles p where p.id=auth.uid()
    and exists(select 1 from auth.sessions s where s.id=private.jwt_session_id() and s.user_id=p.id)
$$;
create function public.complete_staff_login(p_device_name text,p_platform text,p_app_version text) returns jsonb language plpgsql security definer set search_path='' as $$
declare role_name public.user_role:=private.authenticated_role(); existing private.staff_sessions; device uuid; venue uuid; full_auth timestamptz:=private.password_authenticated_at(); expiry timestamptz;
begin
  if role_name is null or (not private.installation_active() and role_name<>'SUPER_ADMIN') then raise exception 'LOGIN_FORBIDDEN' using errcode='42501'; end if;
  if length(p_device_name) not between 1 and 100 or length(p_platform)>100 or length(p_app_version)>50 then raise exception 'INVALID_DEVICE'; end if;
  expiry:=full_auth+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120));
  if full_auth is null or expiry<=now() then raise exception 'FULL_AUTH_REQUIRED' using errcode='42501'; end if;
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
    perform 1 from public.system_limits where id for update;
    if (select count(*) from public.registered_devices where revoked_at is null)>=(select max_devices from public.system_limits where id) then raise exception 'DEVICE_LIMIT'; end if;
    insert into public.registered_devices(user_id,venue_id,display_name,platform,app_version) values(auth.uid(),venue,p_device_name,p_platform,p_app_version) returning id into device;
  elsif role_name<>'SUPER_ADMIN' then raise exception 'VENUE_ASSIGNMENT_REQUIRED';
  end if;
  insert into private.staff_sessions(session_id,user_id,device_id,full_auth_at,unlocked_until) values(private.jwt_session_id(),auth.uid(),device,full_auth,expiry);
  update private.staff_pins set failed_attempts=0,locked_until=null where user_id=auth.uid();
  perform private.audit('AUTH_LOGIN','staff_profiles',auth.uid(),venue);
  return jsonb_build_object('device_id',device,'expires_at',expiry);
end $$;

create function public.lock_staff_session() returns void language plpgsql security definer set search_path='' as $$
begin
  if private.authenticated_role() is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  update private.staff_sessions set unlocked_until=now() where session_id=private.jwt_session_id() and user_id=auth.uid();
  perform private.audit('SESSION_LOCKED','staff_profiles',auth.uid(),null);
end $$;
create function public.set_staff_pin(p_pin text) returns void language plpgsql security definer set search_path='' as $$
begin
  if private.real_role() is null or private.password_authenticated_at()<now()-interval '5 minutes' then raise exception 'FULL_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_pin !~ '^[0-9]{6,10}$' then raise exception 'PIN_FORMAT'; end if;
  insert into private.staff_pins(user_id,pin_hash) values(auth.uid(),extensions.crypt(p_pin,extensions.gen_salt('bf',12)))
    on conflict(user_id) do update set pin_hash=excluded.pin_hash,failed_attempts=0,locked_until=null,updated_at=now();
  perform private.audit('PIN_CHANGED','staff_profiles',auth.uid(),null);
end $$;
create function public.unlock_staff_session(p_pin text) returns jsonb language plpgsql security definer set search_path='' as $$
declare pin private.staff_pins; session private.staff_sessions; expiry timestamptz;
begin
  if private.authenticated_role() is null or (not private.installation_active() and private.authenticated_role()<>'SUPER_ADMIN') then return jsonb_build_object('ok',false,'password_required',true); end if;
  select * into session from private.staff_sessions where session_id=private.jwt_session_id() and user_id=auth.uid() and revoked_at is null for update;
  expiry:=session.full_auth_at+make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120));
  if session.session_id is null or expiry<=now() or exists(select 1 from public.registered_devices where id=session.device_id and revoked_at is not null) then return jsonb_build_object('ok',false,'password_required',true); end if;
  select * into pin from private.staff_pins where user_id=auth.uid() for update;
  if pin.user_id is null or pin.failed_attempts>=5 or pin.locked_until>now() then return jsonb_build_object('ok',false,'password_required',pin.failed_attempts>=5); end if;
  if p_pin !~ '^[0-9]{6,10}$' or extensions.crypt(p_pin,pin.pin_hash)<>pin.pin_hash then
    update private.staff_pins set failed_attempts=failed_attempts+1,locked_until=now()+make_interval(secs=>power(2,pin.failed_attempts)::integer) where user_id=auth.uid();
    perform private.audit('PIN_FAILED','staff_profiles',auth.uid(),null,null,null,'DENIED');
    return jsonb_build_object('ok',false,'password_required',pin.failed_attempts+1>=5);
  end if;
  update private.staff_pins set failed_attempts=0,locked_until=null where user_id=auth.uid();
  update private.staff_sessions set unlocked_until=expiry where session_id=session.session_id;
  perform private.audit('PIN_UNLOCKED','staff_profiles',auth.uid(),null);
  return jsonb_build_object('ok',true,'expires_at',expiry);
end $$;

create function public.revoke_device(p_device uuid) returns void language plpgsql security definer set search_path='' as $$
declare d public.registered_devices;
begin
  select * into d from public.registered_devices where id=p_device for update;
  if d.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(d.venue_id,array['ADMIN']::public.user_role[]);
  update public.registered_devices set revoked_at=now() where id=d.id;
  update private.staff_sessions set revoked_at=now() where device_id=d.id;
  update public.offline_authorization_snapshots set revoked_at=now() where device_id=d.id;
end $$;
grant execute on function public.get_auth_requirements(),public.complete_staff_login(text,text,text),public.lock_staff_session(),public.set_staff_pin(text),public.unlock_staff_session(text),public.revoke_device(uuid) to authenticated;
commit;
