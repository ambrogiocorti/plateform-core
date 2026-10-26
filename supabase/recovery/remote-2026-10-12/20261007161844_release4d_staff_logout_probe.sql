
create or replace function private.test_staff_logout_session_revocation()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='23a86864-3115-4331-b6cb-0f5f74198b1f'::uuid;
  v_session uuid:=gen_random_uuid();
  v_first jsonb;
  v_second jsonb;
  v_revoked_at timestamptz;
  v_audit_count integer;
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
          )
        )
      )::text,
      true
    );

    insert into private.staff_sessions(
      session_id,user_id,device_id,full_auth_at,unlocked_until
    ) values(
      v_session,v_user,null,clock_timestamp(),clock_timestamp()+interval '30 minutes'
    );

    v_first:=public.logout_staff_session();

    select revoked_at
    into v_revoked_at
    from private.staff_sessions
    where session_id=v_session
      and user_id=v_user;

    select count(*)::integer
    into v_audit_count
    from public.audit_log
    where action='AUTH_LOGOUT'
      and resource_type='staff_profiles'
      and resource_id=v_user;

    if coalesce((v_first->>'ok')::boolean,false)<>true
       or coalesce((v_first->>'revoked')::boolean,false)<>true
       or v_revoked_at is null
       or v_audit_count<>1
    then
      raise exception 'STAFF_LOGOUT_FIRST_CALL_FAILED';
    end if;

    v_second:=public.logout_staff_session();

    select count(*)::integer
    into v_audit_count
    from public.audit_log
    where action='AUTH_LOGOUT'
      and resource_type='staff_profiles'
      and resource_id=v_user;

    if coalesce((v_second->>'ok')::boolean,false)<>true
       or coalesce((v_second->>'already_inactive')::boolean,false)<>true
       or v_audit_count<>1
    then
      raise exception 'STAFF_LOGOUT_IDEMPOTENCY_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'first_revoked',true,
      'revoked_at_set',true,
      'audit_rows',v_audit_count,
      'second_call_idempotent',true,
      'second_already_inactive',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_STAFF_LOGOUT_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_STAFF_LOGOUT_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_staff_logout_session_revocation()
from public,anon,authenticated;
grant execute on function private.test_staff_logout_session_revocation()
to service_role,postgres;
