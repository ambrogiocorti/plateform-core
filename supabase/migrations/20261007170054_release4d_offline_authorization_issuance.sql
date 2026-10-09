
do $$
begin
  if not exists(
    select 1
    from vault.decrypted_secrets
    where name='plateform_offline_authorization_hmac'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32),'hex'),
      'plateform_offline_authorization_hmac',
      'HMAC secret for server-issued offline authorization snapshots',
      null
    );
  end if;
end
$$;

create or replace function public.issue_offline_authorization()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_session private.staff_sessions;
  v_profile public.staff_profiles;
  v_claims jsonb;
  v_expires timestamptz;
  v_secret text;
  v_signature text;
  v_snapshot uuid;
begin
  perform private.authorize(
    null,
    array['ADMIN','HOST','WAITER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[]
  );

  if private.impersonation_id() is not null
     or not exists(
       select 1
       from public.feature_flags
       where name='OFFLINE'
         and licensed
     )
  then
    raise exception 'OFFLINE_NOT_AVAILABLE';
  end if;

  select *
  into v_session
  from private.staff_sessions
  where session_id=private.jwt_session_id()
    and user_id=auth.uid()
    and revoked_at is null
  for update;

  if v_session.session_id is null
     or v_session.unlocked_until<=clock_timestamp()
  then
    raise exception 'FULL_AUTH_REQUIRED';
  end if;

  if v_session.device_id is null
     or exists(
       select 1
       from public.registered_devices
       where id=v_session.device_id
         and user_id=auth.uid()
         and revoked_at is not null
     )
  then
    raise exception 'DEVICE_REVOKED';
  end if;

  select *
  into v_profile
  from public.staff_profiles
  where id=auth.uid()
    and active;

  if v_profile.id is null then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;

  v_expires:=least(
    v_session.unlocked_until,
    clock_timestamp()+make_interval(
      mins=(
        select offline_ttl_minutes
        from public.restaurant_settings
        where id
      )
    )
  );

  if v_expires<=clock_timestamp() then
    raise exception 'FULL_AUTH_REQUIRED';
  end if;

  v_claims:=jsonb_build_object(
    'user_id',v_profile.id,
    'role',v_profile.role,
    'scope',v_profile.scope,
    'device_id',v_session.device_id,
    'issued_at',clock_timestamp(),
    'expires_at',v_expires,
    'venue_ids',coalesce(
      (
        select jsonb_agg(id order by id)
        from public.venues
        where active
          and private.has_venue(id)
      ),
      '[]'::jsonb
    ),
    'operational_assignments',
      jsonb_build_object(
        'tables',coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'venue_id',venue_id,
                'table_id',table_id,
                'zone_id',zone_id,
                'mode',mode
              )
            )
            from public.table_assignments
            where waiter_id=v_profile.id
              and active
          ),
          '[]'::jsonb
        ),
        'stations',coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'venue_id',venue_id,
                'station_id',station_id
              )
            )
            from public.station_staff_assignments
            where user_id=v_profile.id
              and active
          ),
          '[]'::jsonb
        )
      )
  );

  select decrypted_secret
  into v_secret
  from vault.decrypted_secrets
  where name='plateform_offline_authorization_hmac'
  order by created_at desc
  limit 1;

  if v_secret is null or length(v_secret)<32 then
    raise exception 'OFFLINE_AUTHORIZATION_SECRET_MISSING';
  end if;

  v_signature:=encode(
    extensions.hmac(v_claims::text,v_secret,'sha256'),
    'hex'
  );

  insert into public.offline_authorization_snapshots(
    user_id,device_id,claims,signature,expires_at
  ) values(
    v_profile.id,
    v_session.device_id,
    v_claims,
    v_signature,
    v_expires
  )
  returning id into v_snapshot;

  perform private.audit(
    'OFFLINE_AUTHORIZATION_ISSUED',
    'offline_authorization_snapshots',
    v_snapshot,
    null,
    null,
    jsonb_build_object(
      'expires_at',v_expires,
      'device_id',v_session.device_id
    )
  );

  return jsonb_build_object(
    'id',v_snapshot,
    'claims',v_claims,
    'expires_at',v_expires
  );
end
$$;

revoke all on function public.issue_offline_authorization()
from public,anon;
grant execute on function public.issue_offline_authorization()
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values('public.issue_offline_authorization()','authenticated')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'OFFLINE_AUTHORIZATION_ISSUANCE',
  'REGRESSION',
  true,
  'Authenticated staff can obtain a server-issued HMAC-signed offline authorization snapshot bound to the active device/session/venues without exposing service_role or signing secrets to the client.'
)
on conflict(key) do nothing;
