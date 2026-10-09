
create or replace function private.test_enable_multi_venue_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='23a86864-3115-4331-b6cb-0f5f74198b1f'::uuid;
  v_session uuid:=gen_random_uuid();
  v_enable_grant uuid:=gen_random_uuid();
  v_create_grant uuid:=gen_random_uuid();
  v_disable_grant uuid:=gen_random_uuid();
  v_enable_key uuid:=gen_random_uuid();
  v_create_key uuid:=gen_random_uuid();
  v_disable_key uuid:=gen_random_uuid();
  v_feature_version bigint;
  v_second uuid;
  v_create jsonb;
  v_create_repeat jsonb;
  v_context jsonb;
  v_disable_error text;
  v_enable_consumed timestamptz;
  v_create_consumed timestamptz;
  v_audit integer;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    if (select count(*) from public.venues where active)<>1 then
      raise exception 'MULTI_VENUE_ENABLE_TEST_REQUIRES_ONE_ACTIVE_VENUE';
    end if;

    update public.feature_flags
    set licensed=false
    where name='MULTI_VENUE';

    set constraints all immediate;

    select version
    into v_feature_version
    from public.feature_flags
    where name='MULTI_VENUE';

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
    perform set_config('request.headers','{}',true);

    insert into private.staff_sessions(
      session_id,user_id,device_id,full_auth_at,unlocked_until
    ) values(
      v_session,v_user,null,clock_timestamp(),clock_timestamp()+interval '30 minutes'
    );

    if private.authenticated_role() is distinct from 'SUPER_ADMIN'::public.user_role
       or private.real_role() is distinct from 'SUPER_ADMIN'::public.user_role
       or private.current_role() is distinct from 'SUPER_ADMIN'::public.user_role
    then
      raise exception 'SUPER_ADMIN_TEST_AUTH_CONTEXT_FAILED';
    end if;

    insert into private.step_up_grants(
      id,user_id,session_id,action,resource_id,expires_at
    ) values(
      v_enable_grant,v_user,v_session,'FEATURE_CHANGE',null,
      clock_timestamp()+interval '5 minutes'
    );

    perform public.save_feature_license(
      'MULTI_VENUE',
      true,
      v_feature_version,
      v_enable_grant,
      v_enable_key
    );

    select consumed_at
    into v_enable_consumed
    from private.step_up_grants
    where id=v_enable_grant;

    if not coalesce(
      (select licensed from public.feature_flags where name='MULTI_VENUE'),
      false
    ) or v_enable_consumed is null then
      raise exception 'MULTI_VENUE_ENABLE_RPC_FAILED';
    end if;

    insert into private.step_up_grants(
      id,user_id,session_id,action,resource_id,expires_at
    ) values(
      v_create_grant,v_user,v_session,'FEATURE_CHANGE',null,
      clock_timestamp()+interval '5 minutes'
    );

    v_create:=public.create_venue(
      'E2E Super Admin Venue',
      'e2e-super-admin-venue',
      'E2ESA2',
      'Via Super Admin 2',
      '+390000007002',
      null,
      'Europe/Rome',
      'EUR',
      'it-IT',
      v_create_grant,
      v_create_key
    );

    v_create_repeat:=public.create_venue(
      'E2E Super Admin Venue',
      'e2e-super-admin-venue',
      'E2ESA2',
      'Via Super Admin 2',
      '+390000007002',
      null,
      'Europe/Rome',
      'EUR',
      'it-IT',
      v_create_grant,
      v_create_key
    );

    if v_create_repeat is distinct from v_create then
      raise exception 'CREATE_VENUE_NOT_IDEMPOTENT';
    end if;

    v_second:=(v_create->>'id')::uuid;

    select consumed_at
    into v_create_consumed
    from private.step_up_grants
    where id=v_create_grant;

    if v_second is null
       or v_create_consumed is null
       or not exists(
         select 1 from public.venues
         where id=v_second and active
       )
       or not exists(
         select 1 from public.venue_settings
         where venue_id=v_second
       )
       or (select count(*) from public.venues where active)<>2
    then
      raise exception 'MULTI_VENUE_CREATE_FLOW_FAILED';
    end if;

    v_context:=public.get_staff_venue_context();

    if not coalesce((v_context->>'multi_venue')::boolean,false)
       or not coalesce((v_context->>'show_selector')::boolean,false)
       or (v_context->>'authorized_venue_count')::integer<>2
    then
      raise exception 'SUPER_ADMIN_MULTI_VENUE_CONTEXT_FAILED';
    end if;

    select count(*)::integer
    into v_audit
    from public.audit_log
    where action='VENUE_CREATED'
      and resource_type='venues'
      and resource_id=v_second;

    if v_audit<1 then
      raise exception 'VENUE_CREATE_AUDIT_FAILED';
    end if;

    insert into private.step_up_grants(
      id,user_id,session_id,action,resource_id,expires_at
    ) values(
      v_disable_grant,v_user,v_session,'FEATURE_CHANGE',null,
      clock_timestamp()+interval '5 minutes'
    );

    select version
    into v_feature_version
    from public.feature_flags
    where name='MULTI_VENUE';

    begin
      perform public.save_feature_license(
        'MULTI_VENUE',
        false,
        v_feature_version,
        v_disable_grant,
        v_disable_key
      );
      v_disable_error:='NO_ERROR';
    exception
      when others then
        v_disable_error:=sqlerrm;
    end;

    if v_disable_error<>'MULTI_VENUE_DISABLED'
       or not coalesce(
         (select licensed from public.feature_flags where name='MULTI_VENUE'),
         false
       )
    then
      raise exception 'MULTI_VENUE_UNSAFE_DISABLE_NOT_BLOCKED';
    end if;

    v_evidence:=jsonb_build_object(
      'real_public_feature_rpc',true,
      'super_admin_aal2_session',true,
      'feature_step_up_consumed',v_enable_consumed is not null,
      'multi_venue_enabled',true,
      'real_public_create_venue_rpc',true,
      'create_step_up_consumed',v_create_consumed is not null,
      'second_active_venue_created',true,
      'venue_settings_created',true,
      'create_idempotent',true,
      'venue_create_audited',v_audit>=1,
      'super_admin_selector_after_enable',true,
      'unsafe_disable_with_two_active_venues',v_disable_error,
      'feature_remained_enabled_after_rejected_disable',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_ENABLE_MULTI_VENUE_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_ENABLE_MULTI_VENUE_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_enable_multi_venue_e2e()
from public,anon,authenticated;
grant execute on function private.test_enable_multi_venue_e2e()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'ENABLE_MULTI_VENUE_E2E',
  'E2E',
  true,
  'Synthetic rollback-only Super Admin AAL2 session uses the real save_feature_license and create_venue RPCs with one-time FEATURE_CHANGE grants; second venue is created idempotently/audited and unsafe disable with two active venues is rejected.'
)
on conflict(key) do nothing;
