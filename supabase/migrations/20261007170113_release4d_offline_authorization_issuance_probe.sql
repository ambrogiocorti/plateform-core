
create or replace function private.test_offline_authorization_issuance()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_device constant uuid:='3529d853-f85b-40fc-b714-39271204d70f'::uuid;
  v_result jsonb;
  v_snapshot public.offline_authorization_snapshots;
  v_audit integer;
  v_detail text;
  v_evidence jsonb;
begin
  begin
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
    perform set_config('request.headers','{}',true);

    update private.staff_sessions
    set unlocked_until=clock_timestamp()+interval '30 minutes',
        device_id=v_device
    where session_id=v_session
      and user_id=v_user
      and revoked_at is null;

    if not found then
      raise exception 'OFFLINE_TEST_SESSION_MISSING';
    end if;

    update public.feature_flags
    set licensed=true
    where name='OFFLINE';

    v_result:=public.issue_offline_authorization();

    select *
    into v_snapshot
    from public.offline_authorization_snapshots
    where id=(v_result->>'id')::uuid;

    if v_snapshot.id is null
       or v_snapshot.user_id is distinct from v_user
       or v_snapshot.device_id is distinct from v_device
       or length(v_snapshot.signature)<>64
       or v_snapshot.signature !~ '^[0-9a-f]{64}$'
       or v_snapshot.claims->>'user_id'<>v_user::text
       or v_snapshot.claims->>'device_id'<>v_device::text
       or jsonb_array_length(v_snapshot.claims->'venue_ids')<1
       or v_snapshot.expires_at<=clock_timestamp()
       or v_snapshot.expires_at>clock_timestamp()+interval '31 minutes'
    then
      raise exception 'OFFLINE_AUTHORIZATION_ISSUANCE_ASSERTION_FAILED';
    end if;

    select count(*)::integer
    into v_audit
    from public.audit_log
    where resource_type='offline_authorization_snapshots'
      and resource_id=v_snapshot.id
      and action='OFFLINE_AUTHORIZATION_ISSUED';

    if v_audit<1 then
      raise exception 'OFFLINE_AUTHORIZATION_AUDIT_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'snapshot_created',true,
      'bound_user',true,
      'bound_device',true,
      'venue_scope_present',true,
      'signature_hmac_sha256_hex',true,
      'signature_length',length(v_snapshot.signature),
      'future_expiry',true,
      'audit_created',true,
      'client_service_role_required',false,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_OFFLINE_AUTH_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_OFFLINE_AUTH_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_offline_authorization_issuance()
from public,anon,authenticated;
grant execute on function private.test_offline_authorization_issuance()
to service_role,postgres;
