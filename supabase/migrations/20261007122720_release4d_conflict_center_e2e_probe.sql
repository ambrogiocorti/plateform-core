
create or replace function private.test_conflict_center_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_device constant uuid:='3529d853-f85b-40fc-b714-39271204d70f'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_event uuid:=gen_random_uuid();
  v_conflict uuid:=gen_random_uuid();
  v_client_event uuid:=gen_random_uuid();
  v_key uuid:=gen_random_uuid();
  v_center jsonb;
  v_item jsonb;
  v_result jsonb;
  v_result_repeat jsonb;
  v_conflict_status text;
  v_sync_status text;
  v_resolved_by uuid;
  v_resolved_at timestamptz;
  v_audit integer;
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

    if not found
       or private.effective_user_id() is distinct from v_user
       or private.current_role() is distinct from 'ADMIN'::public.user_role
    then
      raise exception 'CONFLICT_CENTER_TEST_AUTH_CONTEXT_FAILED';
    end if;

    insert into public.offline_sync_events(
      id,
      client_event_id,
      idempotency_key,
      user_id,
      device_id,
      venue_id,
      resource_type,
      resource_id,
      operation,
      base_version,
      payload,
      sync_status,
      created_at_local,
      received_at,
      synced_at,
      result
    ) values(
      v_event,
      v_client_event,
      gen_random_uuid(),
      v_user,
      v_device,
      v_venue,
      'tables',
      gen_random_uuid(),
      'SET_TABLE_AVAILABLE',
      7,
      '{}'::jsonb,
      'CONFLICT'::public.sync_status,
      clock_timestamp()-interval '5 minutes',
      clock_timestamp()-interval '1 minute',
      clock_timestamp()-interval '30 seconds',
      jsonb_build_object('reason','VERSION_CONFLICT')
    );

    insert into public.sync_conflicts(
      id,venue_id,sync_event_id,reason_code,server_snapshot,status
    ) values(
      v_conflict,
      v_venue,
      v_event,
      'VERSION_CONFLICT',
      jsonb_build_object(
        'resource_id',(select resource_id from public.offline_sync_events where id=v_event),
        'resource_type','tables',
        'version',8,
        'status','OCCUPIED',
        'captured_at',clock_timestamp()
      ),
      'OPEN'
    );

    v_center:=public.get_conflict_center(v_venue,'OPEN',100);

    select value into v_item
    from jsonb_array_elements(v_center->'items')
    where (value->>'id')::uuid=v_conflict
    limit 1;

    if v_item is null
       or v_item->>'venue_id'<>v_venue::text
       or v_item->>'reason_code'<>'VERSION_CONFLICT'
       or v_item->>'resource_type'<>'tables'
       or v_item->>'operation'<>'SET_TABLE_AVAILABLE'
       or v_item->>'user_id'<>v_user::text
       or v_item->>'device_id'<>v_device::text
       or v_item->'server_snapshot' is null
       or v_item->'requested_payload' is null
       or v_item->>'created_at_local' is null
       or v_item->>'synced_at' is null
       or not (v_item->'safe_actions' @> '["ACKNOWLEDGE","DISCARD"]'::jsonb)
    then
      raise exception 'CONFLICT_CENTER_READ_MODEL_FAILED';
    end if;

    v_result:=public.resolve_sync_conflict(
      v_conflict,
      'ACKNOWLEDGE',
      'E2E conflict reviewed and safely rejected',
      v_key
    );

    v_result_repeat:=public.resolve_sync_conflict(
      v_conflict,
      'ACKNOWLEDGE',
      'E2E conflict reviewed and safely rejected',
      v_key
    );

    if v_result_repeat is distinct from v_result then
      raise exception 'CONFLICT_RESOLUTION_NOT_IDEMPOTENT';
    end if;

    select status,resolved_by,resolved_at
    into v_conflict_status,v_resolved_by,v_resolved_at
    from public.sync_conflicts
    where id=v_conflict;

    select sync_status::text
    into v_sync_status
    from public.offline_sync_events
    where id=v_event;

    if v_conflict_status<>'RESOLVED'
       or v_sync_status<>'REJECTED'
       or v_resolved_by is distinct from v_user
       or v_resolved_at is null
    then
      raise exception 'CONFLICT_RESOLUTION_STATE_FAILED';
    end if;

    if exists(
      select 1
      from jsonb_array_elements(public.get_conflict_center(v_venue,'OPEN',100)->'items') x
      where (x->>'id')::uuid=v_conflict
    ) then
      raise exception 'RESOLVED_CONFLICT_STILL_OPEN';
    end if;

    if not exists(
      select 1
      from jsonb_array_elements(public.get_conflict_center(v_venue,'ALL',100)->'items') x
      where (x->>'id')::uuid=v_conflict
        and x->>'status'='RESOLVED'
        and jsonb_array_length(x->'safe_actions')=0
    ) then
      raise exception 'RESOLVED_CONFLICT_HISTORY_MISSING';
    end if;

    select count(*)::integer
    into v_audit
    from public.audit_log
    where resource_type='sync_conflicts'
      and resource_id=v_conflict
      and action='OFFLINE_CONFLICT_RESOLVED';

    if v_audit<1 then
      raise exception 'CONFLICT_RESOLUTION_AUDIT_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'admin_only_rpc',true,
      'venue_present',true,
      'resource_present',true,
      'user_and_device_present',true,
      'local_and_sync_times_present',true,
      'reason_present',true,
      'server_snapshot_present',true,
      'requested_operation_present',true,
      'safe_actions',jsonb_build_array('ACKNOWLEDGE','DISCARD'),
      'resolution_idempotent',true,
      'conflict_final_status',v_conflict_status,
      'offline_event_final_status',v_sync_status,
      'resolved_by_actor',v_resolved_by=v_user,
      'resolved_at_set',v_resolved_at is not null,
      'audit_created',v_audit>=1,
      'resolved_removed_from_open_center',true,
      'resolved_visible_in_history',true,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_CONFLICT_CENTER_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_CONFLICT_CENTER_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_conflict_center_e2e()
from public,anon,authenticated;
grant execute on function private.test_conflict_center_e2e()
to service_role,postgres;
