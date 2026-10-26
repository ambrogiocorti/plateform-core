
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
      or (p.role='ADMIN' and coalesce((select admin_mfa_required from public.restaurant_settings where id),true))
      or (p.role='CASHIER' and coalesce((select cashier_mfa_required from public.restaurant_settings where id),false)),
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
    'pin_enabled',exists(select 1 from private.staff_pins where user_id=p.id),
    'password_required',
      coalesce(
        not p.active
        or private.authenticated_role() is null
        or s.revoked_at is not null
        or s.session_id is null
        or pin.failed_attempts>=5
        or private.password_authenticated_at() is null
        or private.password_authenticated_at()
          + make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120))
          <=now()
        or exists(
          select 1 from public.registered_devices
          where id=s.device_id and revoked_at is not null
        ),
        false
      ),
    'full_auth_expires_at',
      private.password_authenticated_at()
      + make_interval(mins=>coalesce((select full_auth_minutes from public.restaurant_settings where id),120)),
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
      select 1
      from auth.sessions a
      where a.id=private.jwt_session_id()
        and a.user_id=p.id
    )
$$;

create or replace function public.get_initial_setup_state()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_role public.user_role:=private.authenticated_role();
  v_profile public.restaurant_profile;
  v_venue public.venues;
  v_admin_exists boolean;
begin
  if v_role is distinct from 'SUPER_ADMIN'::public.user_role then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select *
  into v_profile
  from public.restaurant_profile
  limit 1;

  select *
  into v_venue
  from public.venues
  where active
  order by created_at,id
  limit 1;

  select exists(
    select 1
    from public.staff_profiles
    where role='ADMIN'
      and active
  )
  into v_admin_exists;

  return jsonb_build_object(
    'profile_configured',v_profile.id is not null,
    'first_venue_configured',v_venue.id is not null,
    'admin_configured',v_admin_exists,
    'complete',v_profile.id is not null and v_venue.id is not null and v_admin_exists,
    'restaurant_name',case when v_profile.id is null then null else v_profile.name end,
    'public_base_url',case when v_profile.id is null then null else v_profile.public_base_url end,
    'staff_base_url',case when v_profile.id is null then null else v_profile.staff_base_url end,
    'identity_domain',case when v_profile.id is null then null else v_profile.staff_identity_domain end,
    'venue_id',v_venue.id,
    'venue_name',v_venue.name
  );
end
$$;

revoke all on function public.get_initial_setup_state()
from public,anon;
grant execute on function public.get_initial_setup_state()
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.get_initial_setup_state()','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'INITIAL_SETUP_RECOVERY_STATE',
  'REGRESSION',
  true,
  'Initial setup remains required until restaurant profile, first active venue and at least one active ADMIN exist; Super Admin can read the resumable setup phase without exposing secrets.'
)
on conflict(key) do nothing;
