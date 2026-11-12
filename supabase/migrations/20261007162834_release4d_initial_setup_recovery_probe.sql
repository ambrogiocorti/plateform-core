
create or replace function private.test_initial_setup_recovery_state()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='23a86864-3115-4331-b6cb-0f5f74198b1f'::uuid;
  v_session uuid:=gen_random_uuid();
  v_before jsonb;
  v_missing_admin jsonb;
  v_requirements jsonb;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    insert into auth.sessions(id,user_id,created_at,updated_at)
    values(v_session,v_user,clock_timestamp(),clock_timestamp());

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user::text,
        'session_id',v_session::text,
        'iat',extract(epoch from clock_timestamp())::bigint,
        'aal','aal2',
        'role','authenticated',
        'amr',jsonb_build_array(
          jsonb_build_object(
            'method','password',
            'timestamp',extract(epoch from clock_timestamp())::bigint
          ),
          jsonb_build_object(
            'method','totp',
            'timestamp',extract(epoch from clock_timestamp())::bigint
          )
        )
      )::text,
      true
    );
    perform set_config('request.headers','{}',true);

    v_before:=public.get_initial_setup_state();

    if not coalesce((v_before->>'profile_configured')::boolean,false)
       or not coalesce((v_before->>'first_venue_configured')::boolean,false)
       or not coalesce((v_before->>'admin_configured')::boolean,false)
       or not coalesce((v_before->>'complete')::boolean,false)
    then
      raise exception 'INITIAL_SETUP_BASELINE_FAILED';
    end if;

    update public.staff_profiles
    set active=false
    where role='ADMIN'
      and active;

    if not found then
      raise exception 'INITIAL_SETUP_ADMIN_FIXTURE_MISSING';
    end if;

    v_missing_admin:=public.get_initial_setup_state();
    v_requirements:=public.get_auth_requirements();

    if coalesce((v_missing_admin->>'admin_configured')::boolean,true)
       or coalesce((v_missing_admin->>'complete')::boolean,true)
       or not coalesce((v_requirements->>'setup_required')::boolean,false)
    then
      raise exception 'INITIAL_SETUP_RECOVERY_ASSERTION_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'super_admin_only',true,
      'baseline_profile_configured',v_before->'profile_configured',
      'baseline_first_venue_configured',v_before->'first_venue_configured',
      'baseline_admin_configured',v_before->'admin_configured',
      'baseline_complete',v_before->'complete',
      'missing_admin_admin_configured',v_missing_admin->'admin_configured',
      'missing_admin_complete',v_missing_admin->'complete',
      'auth_requirements_setup_required',v_requirements->'setup_required',
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_INITIAL_SETUP_RECOVERY_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_INITIAL_SETUP_RECOVERY_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_initial_setup_recovery_state()
from public,anon,authenticated;
grant execute on function private.test_initial_setup_recovery_state()
to service_role,postgres;
