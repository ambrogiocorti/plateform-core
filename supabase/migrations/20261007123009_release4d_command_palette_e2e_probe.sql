
create or replace function private.test_command_palette_authorization_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_service uuid;
  v_reservation uuid:=gen_random_uuid();
  v_forbidden_venue uuid:=gen_random_uuid();
  v_results jsonb;
  v_settings jsonb;
  v_forbidden jsonb;
  v_locked jsonb;
  v_security_definer boolean;
  v_evidence jsonb;
  v_detail text;
begin
  begin
    select id into v_service
    from public.services
    where venue_id=v_venue and active
    order by id
    limit 1;

    if v_service is null then
      raise exception 'COMMAND_PALETTE_TEST_SERVICE_MISSING';
    end if;

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
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session
      and user_id=v_user
      and revoked_at is null;

    if not found
       or private.current_role() is distinct from 'ADMIN'::public.user_role
       or not private.has_venue(v_venue)
    then
      raise exception 'COMMAND_PALETTE_TEST_AUTH_CONTEXT_FAILED';
    end if;

    insert into public.reservations(
      id,venue_id,service_id,service_date,slot_time,
      first_name,last_name,phone,party_size,status,walk_in
    ) values(
      v_reservation,v_venue,v_service,date '2099-03-01','19:00',
      'E2E','Palette Alpha','+390000004001',2,'RESERVED',false
    );

    v_results:=public.search_operational_resources(
      'Palette Alpha',
      v_venue
    );

    if not exists(
      select 1
      from jsonb_array_elements(v_results) x
      where x->>'kind'='RESERVATION'
        and (x->>'id')::uuid=v_reservation
        and (x->>'venue_id')::uuid=v_venue
    ) then
      raise exception 'COMMAND_PALETTE_AUTHORIZED_SEARCH_FAILED';
    end if;

    v_settings:=public.search_operational_resources(
      'Impostazioni',
      v_venue
    );

    if not exists(
      select 1
      from jsonb_array_elements(v_settings) x
      where x->>'kind'='SETTINGS'
        and (x->>'venue_id')::uuid=v_venue
    ) then
      raise exception 'COMMAND_PALETTE_SETTINGS_MISSING';
    end if;

    v_forbidden:=public.search_operational_resources(
      'Palette Alpha',
      v_forbidden_venue
    );

    if jsonb_array_length(v_forbidden)<>0 then
      raise exception 'COMMAND_PALETTE_CROSS_VENUE_LEAK';
    end if;

    select p.prosecdef
    into v_security_definer
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname='search_operational_resources'
      and pg_get_function_identity_arguments(p.oid)='p_query text, p_venue uuid';

    if coalesce(v_security_definer,true) then
      raise exception 'COMMAND_PALETTE_NOT_SECURITY_INVOKER';
    end if;

    update private.staff_sessions
    set unlocked_until=clock_timestamp()-interval '1 minute'
    where session_id=v_session
      and user_id=v_user
      and revoked_at is null;

    v_locked:=public.search_operational_resources(
      'Palette Alpha',
      v_venue
    );

    if jsonb_array_length(v_locked)<>0 then
      raise exception 'COMMAND_PALETTE_LOCKED_SESSION_LEAK';
    end if;

    v_evidence:=jsonb_build_object(
      'authorized_admin_search',true,
      'reservation_result_scoped_to_venue',true,
      'admin_settings_result',true,
      'unauthorized_venue_returns_empty',true,
      'locked_session_returns_empty',true,
      'security_invoker',true,
      'rls_not_bypassed',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_COMMAND_PALETTE_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_COMMAND_PALETTE_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_command_palette_authorization_e2e()
from public,anon,authenticated;
grant execute on function private.test_command_palette_authorization_e2e()
to service_role,postgres;
