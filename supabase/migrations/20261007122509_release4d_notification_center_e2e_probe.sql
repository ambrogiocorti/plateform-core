
create or replace function private.test_notification_center_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_role_notification uuid:=gen_random_uuid();
  v_user_notification uuid:=gen_random_uuid();
  v_other_role_notification uuid:=gen_random_uuid();
  v_expired_notification uuid:=gen_random_uuid();
  v_center jsonb;
  v_summary jsonb;
  v_after_ack jsonb;
  v_status text;
  v_version bigint;
  v_ack_at timestamptz;
  v_resolved_at timestamptz;
  v_expired_status text;
  v_audit_ack integer;
  v_audit_resolve integer;
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
      raise exception 'NOTIFICATION_TEST_AUTH_CONTEXT_FAILED';
    end if;

    insert into public.notifications(
      id,venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v_role_notification,v_venue,'ADMIN','E2E_NOTIFICATION_ROLE',
      'Notification Center role fixture','e2e_notification_fixture',gen_random_uuid()
    );

    insert into public.notifications(
      id,venue_id,recipient_user_id,category,title,resource_type,resource_id
    ) values(
      v_user_notification,v_venue,v_user,'E2E_NOTIFICATION_USER',
      'Notification Center user fixture','e2e_notification_fixture',gen_random_uuid()
    );

    insert into public.notifications(
      id,venue_id,recipient_role,category,title,resource_type,resource_id
    ) values(
      v_other_role_notification,v_venue,'WAITER','E2E_NOTIFICATION_OTHER_ROLE',
      'Notification Center other role fixture','e2e_notification_fixture',gen_random_uuid()
    );

    insert into public.notifications(
      id,venue_id,recipient_role,category,title,expires_at,resource_type,resource_id
    ) values(
      v_expired_notification,v_venue,'ADMIN','E2E_NOTIFICATION_EXPIRED',
      'Notification Center expired fixture',clock_timestamp()-interval '1 minute',
      'e2e_notification_fixture',gen_random_uuid()
    );

    v_center:=public.get_notification_center(v_venue,200);
    v_summary:=public.get_notification_summary(v_venue);

    if not exists(
      select 1
      from jsonb_array_elements(v_center->'items') x
      where (x->>'id')::uuid=v_role_notification
    ) or not exists(
      select 1
      from jsonb_array_elements(v_center->'items') x
      where (x->>'id')::uuid=v_user_notification
    ) or exists(
      select 1
      from jsonb_array_elements(v_center->'items') x
      where (x->>'id')::uuid=v_other_role_notification
    ) or exists(
      select 1
      from jsonb_array_elements(v_center->'items') x
      where (x->>'id')::uuid=v_expired_notification
    ) then
      raise exception 'NOTIFICATION_CENTER_VISIBILITY_FAILED';
    end if;

    select status::text into v_expired_status
    from public.notifications
    where id=v_expired_notification;

    if v_expired_status<>'EXPIRED' then
      raise exception 'NOTIFICATION_EXPIRY_FAILED';
    end if;

    select version into v_version
    from public.notifications
    where id=v_role_notification;

    perform public.transition_notification(
      v_role_notification,
      'ACKNOWLEDGED'::public.notification_status
    );

    select status::text,version,acknowledged_at
    into v_status,v_version,v_ack_at
    from public.notifications
    where id=v_role_notification;

    if v_status<>'ACKNOWLEDGED'
       or v_ack_at is null
       or v_version<>2
    then
      raise exception 'NOTIFICATION_ACK_FAILED';
    end if;

    v_after_ack:=public.get_notification_center(v_venue,200);

    if not exists(
      select 1
      from jsonb_array_elements(v_after_ack->'items') x
      where (x->>'id')::uuid=v_role_notification
        and x->>'status'='ACKNOWLEDGED'
    ) then
      raise exception 'NOTIFICATION_ACK_NOT_PERSISTENT';
    end if;

    perform public.transition_notification(
      v_role_notification,
      'RESOLVED'::public.notification_status
    );

    select status::text,version,resolved_at
    into v_status,v_version,v_resolved_at
    from public.notifications
    where id=v_role_notification;

    if v_status<>'RESOLVED'
       or v_resolved_at is null
       or v_version<>3
    then
      raise exception 'NOTIFICATION_RESOLVE_FAILED';
    end if;

    if exists(
      select 1
      from jsonb_array_elements(public.get_notification_center(v_venue,200)->'items') x
      where (x->>'id')::uuid=v_role_notification
    ) then
      raise exception 'RESOLVED_NOTIFICATION_STILL_ACTIVE';
    end if;

    select count(*)::integer into v_audit_ack
    from public.audit_log
    where resource_type='notifications'
      and resource_id=v_role_notification
      and action='NOTIFICATION_ACKNOWLEDGED';

    select count(*)::integer into v_audit_resolve
    from public.audit_log
    where resource_type='notifications'
      and resource_id=v_role_notification
      and action='NOTIFICATION_RESOLVED';

    if v_audit_ack<1 or v_audit_resolve<1 then
      raise exception 'NOTIFICATION_AUDIT_FAILED';
    end if;

    v_evidence:=jsonb_build_object(
      'authorized_role','ADMIN',
      'role_notification_visible',true,
      'user_notification_visible',true,
      'other_role_hidden',true,
      'expired_hidden_and_transitioned',true,
      'summary_new_count_nonzero',coalesce((v_summary->>'new_count')::integer,0)>=2,
      'acknowledged_persistent',true,
      'resolved_removed_from_active_center',true,
      'acknowledged_at_set',v_ack_at is not null,
      'resolved_at_set',v_resolved_at is not null,
      'single_version_increment_per_transition',v_version=3,
      'audit_acknowledge',v_audit_ack>=1,
      'audit_resolve',v_audit_resolve>=1,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_NOTIFICATION_CENTER_TEST__'
      using detail=v_evidence::text;
  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_NOTIFICATION_CENTER_TEST__' then
        return v_detail::jsonb;
      end if;
      raise;
  end;
end
$$;

revoke all on function private.test_notification_center_e2e()
from public,anon,authenticated;
grant execute on function private.test_notification_center_e2e()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'NOTIFICATION_CENTER_E2E',
  'E2E',
  true,
  'Authorized Notification Center shows role/user notifications only, expires stale items, persists ACKNOWLEDGED/RESOLVED transitions with timestamps, audit and one version increment per transition.'
)
on conflict(key) do nothing;
