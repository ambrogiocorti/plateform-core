
begin;

alter table public.restaurant_settings
  add column if not exists full_auth_mode text not null default 'FIXED';
alter table public.restaurant_settings
  drop constraint if exists restaurant_settings_full_auth_mode_check;
alter table public.restaurant_settings
  add constraint restaurant_settings_full_auth_mode_check
  check(full_auth_mode in ('FIXED','SHIFT_END'));

alter table private.staff_sessions
  add column if not exists full_auth_expires_at timestamptz;
update private.staff_sessions s
set full_auth_expires_at=s.full_auth_at+make_interval(
  mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120)
)
where s.full_auth_expires_at is null;

create or replace function private.staff_full_auth_expiry(
  p_user uuid,
  p_authenticated_at timestamptz
)
returns timestamptz
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_mode text:='FIXED';
  v_minutes integer:=120;
  v_shift_end timestamptz;
begin
  if p_user is null or p_authenticated_at is null then return null; end if;
  select full_auth_mode,full_auth_minutes
  into v_mode,v_minutes
  from public.restaurant_settings
  where id;
  v_mode:=coalesce(v_mode,'FIXED');
  v_minutes:=coalesce(v_minutes,120);

  if v_mode='SHIFT_END' then
    select s.ends_at
    into v_shift_end
    from public.shifts s
    where s.staff_id=p_user
      and s.starts_at<=p_authenticated_at
      and s.ends_at>p_authenticated_at
    order by s.ends_at,s.id
    limit 1;
    if v_shift_end is not null then return v_shift_end; end if;
  end if;

  return p_authenticated_at+make_interval(mins=>v_minutes);
end
$$;
revoke all on function private.staff_full_auth_expiry(uuid,timestamptz)
from public,anon,authenticated;

create or replace function private.real_role()
returns public.user_role
language sql
stable
security definer
set search_path=''
as $$
  select private.authenticated_role()
  where (
    (
      not exists(select 1 from public.restaurant_profile)
      and private.authenticated_role()='SUPER_ADMIN'
      and private.staff_full_auth_expiry(
        auth.uid(),private.password_authenticated_at()
      )>now()
    )
    or exists(
      select 1
      from private.staff_sessions s
      where s.session_id=private.jwt_session_id()
        and s.user_id=auth.uid()
        and s.revoked_at is null
        and s.unlocked_until>now()
        and coalesce(
          s.full_auth_expires_at,
          private.staff_full_auth_expiry(s.user_id,s.full_auth_at)
        )>now()
        and (
          s.device_id is null
          or exists(
            select 1 from public.registered_devices d
            where d.id=s.device_id
              and d.user_id=auth.uid()
              and d.revoked_at is null
          )
        )
    )
  )
$$;

create or replace function public.complete_staff_login(
  p_device_name text,
  p_platform text,
  p_app_version text,
  p_device uuid default null,
  p_device_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  role_name public.user_role:=private.authenticated_role();
  existing private.staff_sessions;
  device uuid;
  venue uuid;
  full_auth timestamptz:=private.password_authenticated_at();
  expiry timestamptz;
  registered public.registered_devices;
begin
  if role_name is null
     or (not private.installation_active() and role_name<>'SUPER_ADMIN') then
    raise exception 'LOGIN_FORBIDDEN' using errcode='42501';
  end if;
  if p_device_name is null
     or length(p_device_name) not between 1 and 100
     or p_platform is null
     or length(p_platform)>100
     or p_app_version is null
     or length(p_app_version)>50 then
    raise exception 'INVALID_DEVICE';
  end if;

  expiry:=private.staff_full_auth_expiry(auth.uid(),full_auth);
  if full_auth is null or expiry is null or expiry<=now() then
    raise exception 'FULL_AUTH_REQUIRED' using errcode='42501';
  end if;

  perform 1 from public.staff_profiles where id=auth.uid() for update;
  select * into existing
  from private.staff_sessions
  where session_id=private.jwt_session_id()
  for update;

  if existing.session_id is not null then
    if existing.revoked_at is not null
       or existing.unlocked_until<=now()
       or coalesce(
         existing.full_auth_expires_at,
         private.staff_full_auth_expiry(existing.user_id,existing.full_auth_at)
       )<=now() then
      raise exception 'PIN_OR_FULL_AUTH_REQUIRED' using errcode='42501';
    end if;
    if existing.device_id is not null
       and exists(
         select 1 from public.registered_devices
         where id=existing.device_id and revoked_at is not null
       ) then
      raise exception 'DEVICE_REVOKED' using errcode='42501';
    end if;
    return jsonb_build_object(
      'device_id',existing.device_id,
      'expires_at',least(
        existing.unlocked_until,
        coalesce(existing.full_auth_expires_at,expiry)
      )
    );
  end if;

  select v.id into venue
  from public.venues v
  where v.active
    and (
      exists(
        select 1 from public.staff_profiles p
        where p.id=auth.uid() and p.scope='CHAIN'
      )
      or exists(
        select 1 from public.staff_venue_assignments a
        where a.user_id=auth.uid()
          and a.venue_id=v.id
          and a.active
      )
    )
  order by v.name
  limit 1;

  if venue is not null then
    if p_device_token is null
       or p_device_token !~ '^[A-Za-z0-9_-]{43}$' then
      raise exception 'INVALID_DEVICE_TOKEN';
    end if;
    if p_device is not null then
      select * into registered
      from public.registered_devices
      where id=p_device and user_id=auth.uid()
      for update;
      if registered.id is null
         or not exists(
           select 1 from private.device_registration_secrets
           where device_id=p_device
             and token_hash=extensions.digest(p_device_token,'sha256')
         ) then
        raise exception 'INVALID_DEVICE_TOKEN' using errcode='42501';
      end if;
      if registered.revoked_at is not null then
        raise exception 'DEVICE_REVOKED' using errcode='42501';
      end if;
      device:=registered.id;
      update public.registered_devices
      set venue_id=venue,
          display_name=p_device_name,
          platform=p_platform,
          app_version=p_app_version,
          last_seen_at=now()
      where id=device;
    else
      perform 1 from public.system_limits where id for update;
      if (select count(*) from public.registered_devices where revoked_at is null)
         >=(select max_devices from public.system_limits where id) then
        raise exception 'DEVICE_LIMIT';
      end if;
      insert into public.registered_devices(
        user_id,venue_id,display_name,platform,app_version
      ) values(
        auth.uid(),venue,p_device_name,p_platform,p_app_version
      ) returning id into device;
      insert into private.device_registration_secrets(device_id,token_hash)
      values(device,extensions.digest(p_device_token,'sha256'));
    end if;
  elsif role_name<>'SUPER_ADMIN' then
    raise exception 'VENUE_ASSIGNMENT_REQUIRED';
  end if;

  insert into private.staff_sessions(
    session_id,user_id,device_id,full_auth_at,full_auth_expires_at,unlocked_until
  ) values(
    private.jwt_session_id(),auth.uid(),device,full_auth,expiry,expiry
  );
  update private.staff_pins
  set failed_attempts=0,locked_until=null
  where user_id=auth.uid();
  perform private.audit('AUTH_LOGIN','staff_profiles',auth.uid(),venue);
  return jsonb_build_object('device_id',device,'expires_at',expiry);
end
$$;

create or replace function public.unlock_staff_session(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  pin private.staff_pins;
  session private.staff_sessions;
  expiry timestamptz;
begin
  if private.authenticated_role() is null
     or (not private.installation_active() and private.authenticated_role()<>'SUPER_ADMIN') then
    return jsonb_build_object('ok',false,'password_required',true);
  end if;

  select * into session
  from private.staff_sessions
  where session_id=private.jwt_session_id()
    and user_id=auth.uid()
    and revoked_at is null
  for update;
  expiry:=coalesce(
    session.full_auth_expires_at,
    private.staff_full_auth_expiry(session.user_id,session.full_auth_at)
  );

  if session.session_id is null
     or expiry is null
     or expiry<=now()
     or exists(
       select 1 from public.registered_devices
       where id=session.device_id and revoked_at is not null
     ) then
    return jsonb_build_object('ok',false,'password_required',true);
  end if;

  select * into pin
  from private.staff_pins
  where user_id=auth.uid()
  for update;
  if pin.user_id is null then
    return jsonb_build_object('ok',false,'password_required',true);
  end if;
  if pin.failed_attempts>=5 or pin.locked_until>now() then
    return jsonb_build_object('ok',false,'password_required',pin.failed_attempts>=5);
  end if;

  if p_pin is null
     or p_pin !~ '^[0-9]{6,10}$'
     or extensions.crypt(p_pin,pin.pin_hash) is distinct from pin.pin_hash then
    update private.staff_pins
    set failed_attempts=failed_attempts+1,
        locked_until=now()+make_interval(secs=>power(2,pin.failed_attempts)::integer)
    where user_id=auth.uid();
    perform private.audit(
      'PIN_FAILED','staff_profiles',auth.uid(),null,null,null,'DENIED'
    );
    return jsonb_build_object(
      'ok',false,
      'password_required',pin.failed_attempts+1>=5
    );
  end if;

  update private.staff_pins
  set failed_attempts=0,locked_until=null
  where user_id=auth.uid();
  update private.staff_sessions
  set unlocked_until=expiry
  where session_id=session.session_id;
  perform private.audit('PIN_UNLOCKED','staff_profiles',auth.uid(),null);
  return jsonb_build_object('ok',true,'expires_at',expiry);
end
$$;

create or replace function public.get_auth_requirements()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'role',p.role,
    'display_name',p.display_name,
    'active',p.active,
    'mfa_required',
      p.role='SUPER_ADMIN'
      or (
        p.role='ADMIN'
        and coalesce(
          (select admin_mfa_required from public.restaurant_settings where id),
          true
        )
      )
      or (
        p.role='CASHIER'
        and coalesce(
          (select cashier_mfa_required from public.restaurant_settings where id),
          false
        )
      ),
    'installation_active',private.installation_active(),
    'setup_required',
      not exists(select 1 from public.restaurant_profile)
      or not exists(
        select 1
        from public.staff_profiles admin_profile
        where admin_profile.role='ADMIN'
          and admin_profile.active
      ),
    'session_unlocked',private.real_role() is not null,
    'pin_enabled',exists(
      select 1 from private.staff_pins where user_id=p.id
    ),
    'password_required',
      coalesce(
        not p.active
        or private.authenticated_role() is null
        or s.revoked_at is not null
        or s.session_id is null
        or pin.failed_attempts>=5
        or coalesce(
          s.full_auth_expires_at,
          private.staff_full_auth_expiry(
            p.id,
            coalesce(s.full_auth_at,private.password_authenticated_at())
          )
        )<=now()
        or exists(
          select 1 from public.registered_devices
          where id=s.device_id and revoked_at is not null
        ),
        false
      ),
    'full_auth_expires_at',
      coalesce(
        s.full_auth_expires_at,
        private.staff_full_auth_expiry(
          p.id,
          coalesce(s.full_auth_at,private.password_authenticated_at())
        )
      ),
    'retry_after_seconds',
      greatest(0,ceil(extract(epoch from pin.locked_until-now())))::integer
  )
  from public.staff_profiles p
  left join private.staff_sessions s
    on s.session_id=private.jwt_session_id()
   and s.user_id=p.id
  left join private.staff_pins pin
    on pin.user_id=p.id
  where p.id=auth.uid()
    and exists(
      select 1 from auth.sessions a
      where a.id=private.jwt_session_id()
        and a.user_id=p.id
    )
$$;

create or replace function public.get_admin_authentication_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_settings public.restaurant_settings;
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then
    raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
  end if;
  select * into v_settings
  from public.restaurant_settings
  where id;
  return jsonb_build_object(
    'admin_mfa_required',v_settings.admin_mfa_required,
    'cashier_mfa_required',v_settings.cashier_mfa_required,
    'full_auth_mode',v_settings.full_auth_mode,
    'full_auth_minutes',v_settings.full_auth_minutes,
    'offline_ttl_minutes',v_settings.offline_ttl_minutes,
    'version',v_settings.version
  );
end
$$;
revoke all on function public.get_admin_authentication_settings()
from public,anon;
grant execute on function public.get_admin_authentication_settings()
to authenticated,service_role;

create or replace function public.configure_authentication_v2(
  p_version bigint,
  p_admin_mfa boolean,
  p_cashier_mfa boolean,
  p_full_auth_mode text,
  p_full_auth integer,
  p_offline_ttl integer,
  p_grant uuid,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  result jsonb;
  settings public.restaurant_settings;
  v_mode text:=upper(trim(coalesce(p_full_auth_mode,'')));
begin
  perform private.authorize(null,array['ADMIN']::public.user_role[]);
  if private.current_scope()<>'CHAIN' then
    raise exception 'CHAIN_SCOPE_REQUIRED' using errcode='42501';
  end if;

  result:=private.idempotency_begin(
    'authentication_config_v2',
    p_key,
    jsonb_build_object(
      'version',p_version,
      'admin_mfa',p_admin_mfa,
      'cashier_mfa',p_cashier_mfa,
      'full_auth_mode',v_mode,
      'full_auth',p_full_auth,
      'offline_ttl',p_offline_ttl
    )
  );
  if result is not null then return result; end if;

  perform private.consume_step_up(p_grant,'FEATURE_CHANGE');
  select * into settings
  from public.restaurant_settings
  where id
  for update;
  if settings.version is distinct from p_version then
    raise exception 'VERSION_CONFLICT';
  end if;

  if p_admin_mfa is null
     or p_cashier_mfa is null
     or v_mode not in ('FIXED','SHIFT_END')
     or p_full_auth is null
     or p_full_auth not between 30 and 720
     or p_offline_ttl is null
     or p_offline_ttl not between 5 and 120
     or p_offline_ttl>p_full_auth then
    raise exception 'INVALID_SETTINGS';
  end if;

  update public.restaurant_settings
  set admin_mfa_required=p_admin_mfa,
      cashier_mfa_required=p_cashier_mfa,
      full_auth_mode=v_mode,
      full_auth_minutes=p_full_auth,
      offline_ttl_minutes=p_offline_ttl
  where id;

  update public.offline_authorization_snapshots
  set revoked_at=now()
  where revoked_at is null;

  perform private.audit(
    'AUTHENTICATION_CONFIG_CHANGED',
    'restaurant_settings',
    null,
    null,
    jsonb_build_object(
      'admin_mfa_required',settings.admin_mfa_required,
      'cashier_mfa_required',settings.cashier_mfa_required,
      'full_auth_mode',settings.full_auth_mode,
      'full_auth_minutes',settings.full_auth_minutes,
      'offline_ttl_minutes',settings.offline_ttl_minutes,
      'version',settings.version
    ),
    jsonb_build_object(
      'admin_mfa_required',p_admin_mfa,
      'cashier_mfa_required',p_cashier_mfa,
      'full_auth_mode',v_mode,
      'full_auth_minutes',p_full_auth,
      'offline_ttl_minutes',p_offline_ttl,
      'version',settings.version+1
    )
  );

  return private.idempotency_finish(
    'authentication_config_v2',
    p_key,
    jsonb_build_object('version',settings.version+1)
  );
end
$$;
revoke all on function public.configure_authentication_v2(
  bigint,boolean,boolean,text,integer,integer,uuid,uuid
)
from public,anon;
grant execute on function public.configure_authentication_v2(
  bigint,boolean,boolean,text,integer,integer,uuid,uuid
)
to authenticated,service_role;

revoke all on function public.configure_authentication(
  bigint,boolean,boolean,integer,integer,uuid,uuid
)
from public,anon,authenticated;
grant execute on function public.configure_authentication(
  bigint,boolean,boolean,integer,integer,uuid,uuid
)
to service_role;

delete from private.api_permission_manifest
where function_identity=
  'public.configure_authentication(bigint,boolean,boolean,integer,integer,uuid,uuid)'
  and api_role='authenticated';
insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.get_admin_authentication_settings()','authenticated'),
  ('public.configure_authentication_v2(bigint,boolean,boolean,text,integer,integer,uuid,uuid)','authenticated')
on conflict do nothing;

create or replace function private.test_full_auth_shift_mode_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_expiry_def text;
  v_login_def text;
  v_unlock_def text;
  v_config_def text;
  v_normalized text;
begin
  select pg_get_functiondef(
    'private.staff_full_auth_expiry(uuid,timestamp with time zone)'::regprocedure
  ) into v_expiry_def;
  select pg_get_functiondef(
    'public.complete_staff_login(text,text,text,uuid,text)'::regprocedure
  ) into v_login_def;
  select pg_get_functiondef(
    'public.unlock_staff_session(text)'::regprocedure
  ) into v_unlock_def;
  select pg_get_functiondef(
    'public.configure_authentication_v2(bigint,boolean,boolean,text,integer,integer,uuid,uuid)'::regprocedure
  ) into v_config_def;

  v_normalized:=regexp_replace(
    coalesce(v_expiry_def,'')
      ||coalesce(v_login_def,'')
      ||coalesce(v_unlock_def,'')
      ||coalesce(v_config_def,''),
    '[[:space:]]+','','g'
  );

  if not exists(
       select 1 from information_schema.columns
       where table_schema='public'
         and table_name='restaurant_settings'
         and column_name='full_auth_mode'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='private'
         and table_name='staff_sessions'
         and column_name='full_auth_expires_at'
     )
     or v_normalized not like '%full_auth_mode%SHIFT_END%'
     or v_normalized not like '%frompublic.shiftss%'
     or v_normalized not like '%full_auth_expires_at%'
     or v_normalized not like '%array[''ADMIN'']::public.user_role[]%'
     or v_normalized not like '%CHAIN_SCOPE_REQUIRED%'
  then
    raise exception 'FULL_AUTH_SHIFT_MODE_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'modes',jsonb_build_array('FIXED','SHIFT_END'),
    'shift_end_from_planned_shift',true,
    'fixed_fallback_minutes',true,
    'session_expiry_persisted',true,
    'pin_reuses_persisted_expiry',true,
    'configured_by','ADMIN_CHAIN',
    'legacy_browser_rpc_revoked',true
  );
end
$$;
revoke all on function private.test_full_auth_shift_mode_contract()
from public,anon,authenticated;
grant execute on function private.test_full_auth_shift_mode_contract()
to service_role,postgres;

insert into private.release_test_catalog(
  key,category,required,description
)
values(
  'FULL_AUTH_SHIFT_MODE_CONTRACT',
  'REGRESSION',
  true,
  'Full-auth duration supports fixed minutes or planned-shift end, persists the computed expiry in the staff session, keeps PIN unlock bounded by that expiry, and is configured only by CHAIN Admin with step-up.'
)
on conflict(key) do nothing;

commit;
