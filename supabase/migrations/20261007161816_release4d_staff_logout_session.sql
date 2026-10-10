
create or replace function public.logout_staff_session()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid:=auth.uid();
  v_session private.staff_sessions;
  v_venue uuid;
begin
  if v_actor is null or private.authenticated_role() is null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  select *
  into v_session
  from private.staff_sessions
  where session_id=private.jwt_session_id()
    and user_id=v_actor
  for update;

  if v_session.session_id is null then
    return jsonb_build_object(
      'ok',true,
      'revoked',false,
      'already_inactive',true
    );
  end if;

  if v_session.revoked_at is not null then
    return jsonb_build_object(
      'ok',true,
      'revoked',false,
      'already_inactive',true
    );
  end if;

  if v_session.device_id is not null then
    select venue_id
    into v_venue
    from public.registered_devices
    where id=v_session.device_id
      and user_id=v_actor;
  end if;

  perform private.audit(
    'AUTH_LOGOUT',
    'staff_profiles',
    v_actor,
    v_venue,
    jsonb_build_object(
      'session_id',v_session.session_id,
      'device_id',v_session.device_id,
      'unlocked_until',v_session.unlocked_until
    ),
    jsonb_build_object(
      'revoked',true
    ),
    'ALLOWED'
  );

  update private.staff_sessions
  set revoked_at=clock_timestamp(),
      unlocked_until=least(unlocked_until,clock_timestamp())
  where session_id=v_session.session_id
    and user_id=v_actor
    and revoked_at is null;

  return jsonb_build_object(
    'ok',true,
    'revoked',true,
    'already_inactive',false
  );
end
$$;

revoke all on function public.logout_staff_session()
from public,anon;
grant execute on function public.logout_staff_session()
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.logout_staff_session()','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'STAFF_LOGOUT_SESSION_REVOCATION',
  'SECURITY',
  true,
  'Staff logout explicitly revokes the current operational staff_session and writes AUTH_LOGOUT audit evidence; repeated calls are idempotent.'
)
on conflict(key) do nothing;
