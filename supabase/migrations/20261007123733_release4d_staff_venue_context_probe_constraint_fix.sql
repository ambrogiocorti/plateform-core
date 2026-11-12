
create or replace function private.test_staff_venue_context_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_device constant uuid:='3529d853-f85b-40fc-b714-39271204d70f'::uuid;
  v_primary constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_second uuid:=gen_random_uuid();
  v_mono jsonb;
  v_single jsonb;
  v_multi jsonb;
  v_selected jsonb;
  v_after_revoke jsonb;
  v_disabled_error text;
  v_revoked_error text;
  v_evidence jsonb;
  v_detail text;
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
    set unlocked_until=clock_timestamp()+interval '30 minutes'
    where session_id=v_session
      and user_id=v_user
      and revoked_at is null;

    update public.registered_devices
    set venue_id=v_primary
    where id=v_device
      and user_id=v_user
      and revoked_at is null;

    update public.feature_flags
    set licensed=false
    where name='MULTI_VENUE';

    if (select count(*) from public.venues where active)<>1 then
      raise exception 'MONO_TEST_REQUIRES_ONE_ACTIVE_VENUE';
    end if;

    v_mono:=public.get_staff_venue_context();

    if coalesce((v_mono->>'multi_venue')::boolean,true)
       or coalesce((v_mono->>'show_selector')::boolean,true)
       or not coalesce((v_mono->>'auto_open')::boolean,false)
       or (v_mono->>'authorized_venue_count')::integer<>1
       or (v_mono->>'current_venue_id')::uuid<>v_primary
    then
      raise exception 'MONO_VENUE_CONTEXT_FAILED';
    end if;

    begin
      insert into public.venues(
        id,name,slug,code,address,phone,timezone,currency,locale,active,operational_status
      ) values(
        v_second,
        'E2E Venue Secondary',
        'e2e-venue-secondary',
        'E2EV2',
        'Via E2E 2',
        '+390000005002',
        'Europe/Rome',
        'EUR',
        'it-IT',
        true,
        'OPEN'
      );
      set constraints all immediate;
      v_disabled_error:='NO_ERROR';
    exception
      when others then
        v_disabled_error:=sqlerrm;
    end;

    set constraints all deferred;

    if v_disabled_error<>'MULTI_VENUE_DISABLED' then
      raise exception 'MULTI_VENUE_DISABLED_INVARIANT_FAILED';
    end if;

    update public.feature_flags
    set licensed=true
    where name='MULTI_VENUE';

    insert into public.venues(
      id,name,slug,code,address,phone,timezone,currency,locale,active,operational_status
    ) values(
      v_second,
      'E2E Venue Secondary',
      'e2e-venue-secondary',
      'E2EV2',
      'Via E2E 2',
      '+390000005002',
      'Europe/Rome',
      'EUR',
      'it-IT',
      true,
      'OPEN'
    );

    v_single:=public.get_staff_venue_context();

    if not coalesce((v_single->>'multi_venue')::boolean,false)
       or coalesce((v_single->>'show_selector')::boolean,true)
       or not coalesce((v_single->>'auto_open')::boolean,false)
       or (v_single->>'authorized_venue_count')::integer<>1
       or (v_single->>'current_venue_id')::uuid<>v_primary
    then
      raise exception 'SINGLE_ASSIGNMENT_CONTEXT_FAILED';
    end if;

    insert into public.staff_venue_assignments(user_id,venue_id,active)
    values(v_user,v_second,true)
    on conflict(user_id,venue_id) do update set active=true;

    v_multi:=public.get_staff_venue_context();

    if not coalesce((v_multi->>'multi_venue')::boolean,false)
       or not coalesce((v_multi->>'show_selector')::boolean,false)
       or coalesce((v_multi->>'auto_open')::boolean,true)
       or (v_multi->>'authorized_venue_count')::integer<>2
       or jsonb_array_length(v_multi->'venues')<>2
    then
      raise exception 'MULTI_ASSIGNMENT_CONTEXT_FAILED';
    end if;

    v_selected:=public.set_operational_venue(v_second);

    if (v_selected->>'current_venue_id')::uuid<>v_second
       or not coalesce((v_selected->>'show_selector')::boolean,false)
    then
      raise exception 'OPERATIONAL_VENUE_SELECTION_FAILED';
    end if;

    update public.staff_venue_assignments
    set active=false
    where user_id=v_user
      and venue_id=v_second;

    v_after_revoke:=public.get_staff_venue_context();

    if (v_after_revoke->>'current_venue_id')::uuid<>v_primary
       or (v_after_revoke->>'authorized_venue_count')::integer<>1
       or coalesce((v_after_revoke->>'show_selector')::boolean,true)
    then
      raise exception 'REVOKED_VENUE_CONTEXT_FAILED';
    end if;

    begin
      perform public.set_operational_venue(v_second);
      v_revoked_error:='NO_ERROR';
    exception
      when others then
        v_revoked_error:=sqlerrm;
    end;

    if v_revoked_error<>'VENUE_FORBIDDEN' then
      raise exception 'REVOKED_VENUE_SELECTION_NOT_BLOCKED';
    end if;

    v_evidence:=jsonb_build_object(
      'mono_multi_venue',v_mono->'multi_venue',
      'mono_show_selector',v_mono->'show_selector',
      'mono_auto_open',v_mono->'auto_open',
      'disabled_second_venue_error',v_disabled_error,
      'enabled_second_venue_created',true,
      'single_assignment_count',(v_single->>'authorized_venue_count')::integer,
      'single_assignment_show_selector',v_single->'show_selector',
      'single_assignment_auto_open',v_single->'auto_open',
      'multi_assignment_count',(v_multi->>'authorized_venue_count')::integer,
      'multi_assignment_show_selector',v_multi->'show_selector',
      'operational_venue_persisted',(v_selected->>'current_venue_id')::uuid=v_second,
      'revoked_assignment_removed_from_context',true,
      'revoked_venue_selection_error',v_revoked_error,
      'current_venue_not_authorization_source',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_STAFF_VENUE_CONTEXT_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_STAFF_VENUE_CONTEXT_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;
