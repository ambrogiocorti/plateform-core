
create or replace function private.test_notification_center_e2e()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid;
  v_session uuid;
  v_venue uuid;
  v_role_notification uuid:=gen_random_uuid();
  v_user_notification uuid:=gen_random_uuid();
  v_foreign_role_notification uuid:=gen_random_uuid();
  v_expired_notification uuid:=gen_random_uuid();
  v_resource uuid:=gen_random_uuid();
  v_center jsonb;
  v_summary jsonb;
  v_items jsonb;
  v_role_status text;
  v_expired_status text;
  v_ack_at timestamptz;
  v_resolved_at timestamptz;
  v_version bigint;
  v_audit_count integer;
  v_evidence jsonb;
  v_detail text;
  v_now timestamptz:=clock_timestamp();
begin
  begin
    select sp.id,s.id,sva.venue_id
    into v_user,v_session,v_venue
    from public.staff_profiles sp
    join auth.sessions s on s.user_id=sp.id
    join public.staff_venue_assignments sva
      on sva.user_id=sp.id and sva.active
    where sp.active
      and sp.role='ADMIN'
    order by s.created_at desc
    limit 1;

    if v_user is null or v_session is null or v_venue is null then
      raise exception 'NOTIFICATION_E2E_FIXTURE_UNAVAILABLE';
    end if;

    insert into private.staff_sessions(
      session_id,user_id,device_id,full_auth_at,unlocked_until,revoked_at
    ) values(
      v_session,v_user,null,v_now,v_now+interval '30 minutes',null
    )
    on conflict(session_id) do update
    set user_id=excluded.user_id,
        device_id=null,
        full_auth_at=excluded.full_auth_at,
        unlocked_until=excluded.unlocked_until,
        revoked_at=null;

    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user,
        'session_id',v_session,
        'iat',extract(epoch from v_now)::bigint,
        'aal','aal2',
        'role','authenticated',
        'amr',jsonb_build_array(
          jsonb_build_object(
            'method','password',
            'timestamp',extract(epoch from v_now)::bigint
          )
        )
      )::text,
      true
    );

    if private.effective_user_id() is distinct from v_user
       or private.current_role()<>'ADMIN'
    then
      raise exception 'NOTIFICATION_E2E_AUTH_CONTEXT_FAILED';
    end if;

    insert into public.notifications(
      id,venue_id,recipient_role,category,priority,title,
      expires_at,resource_type,resource_id
    ) values(
      v_role_notification,v_venue,'ADMIN','E2E_ROLE','WARNING',
      'E2E role notification',
      v_now+interval '1 hour','e2e_notification',v_resource
    );

    insert into public.notifications(
      id,venue_id,recipient_user_id,category,priority,title,
      expires_at,resource_type,resource_id
    ) values(
      v_user_notification,v_venue,v_user,'E2E_USER','INFO',
      'E2E user notification',
      v_now+interval '1 hour','e2e_notification',v_resource
    );

    insert into public.notifications(
      id,venue_id,recipient_role,category,priority,title,
      expires_at,resource_type,resource_id
    ) values(
      v_foreign_role_notification,v_venue,'WAITER','E2E_FOREIGN_ROLE','INFO',
      'E2E foreign role notification',
      v_now+interval '1 hour','e2e_notification',v_resource
    );

    insert into public.notifications(
      id,venue_id,recipient_role,category,priority,title,
      expires_at,resource_type,resource_id
    ) values(
      v_expired_notification,v_venue,'ADMIN','E2E_EXPIRED','INFO',
      'E2E expired notification',
      v_now-interval '1 minute','e2e_notification',v_resource
    );

    v_summary:=public.get_notification_summary(v_venue);
    v_center:=public.get_notification_center(v_venue,100);
    v_items:=v_center->'items';

    select status::text into v_expired_status
    from public.notifications
    where id=v_expired_notification;

    if v_expired_status<>'EXPIRED'
       or not exists(
         select 1 from jsonb_array_elements(v_items) x
         where (x->>'id')::uuid=v_role_notification
       )
       or not exists(
         select 1 from jsonb_array_elements(v_items) x
         where (x->>'id')::uuid=v_user_notification
       )
       or exists(
         select 1 from jsonb_array_elements(v_items) x
         where (x->>'id')::uuid=v_foreign_role_notification
       )
       or exists(
         select 1 from jsonb_array_elements(v_items) x
         where (x->>'id')::uuid=v_expired_notification
       )
    then
      raise exception 'NOTIFICATION_CENTER_FILTER_FAILED';
    end if;

    perform public.transition_notification(
      v_role_notification,
      'ACKNOWLEDGED'::public.notification_status
    );

    select status::text,acknowledged_at,version
    into v_role_status,v_ack_at,v_version
    from public.notifications
    where id=v_role_notification;

    if v_role_status<>'ACKNOWLEDGED'
       or v_ack_at is null
       or v_version<>2
    then
      raise exception 'NOTIFICATION_ACK_FAILED';
    end if;

    perform public.transition_notification(
      v_role_notification,
      'RESOLVED'::public.notification_status
    );

    select status::text,resolved_at,version
    into v_role_status,v_resolved_at,v_version
    from public.notifications
    where id=v_role_notification;

    if v_role_status<>'RESOLVED'
       or v_resolved_at is null
       or v_version<>3
    then
      raise exception 'NOTIFICATION_RESOLVE_FAILED';
    end if;

    select count(*)::integer
    into v_audit_count
    from public.audit_log
    where resource_type='notifications'
      and resource_id=v_role_notification
      and action in ('NOTIFICATION_ACKNOWLEDGED','NOTIFICATION_RESOLVED');

    if v_audit_count<>2 then
      raise exception 'NOTIFICATION_AUDIT_FAILED';
    end if;

    v_center:=public.get_notification_center(v_venue,100);
    v_items:=v_center->'items';

    if exists(
      select 1 from jsonb_array_elements(v_items) x
      where (x->>'id')::uuid=v_role_notification
    ) then
      raise exception 'RESOLVED_NOTIFICATION_STILL_ACTIVE';
    end if;

    v_evidence:=jsonb_build_object(
      'authorized_role','ADMIN',
      'role_target_visible',true,
      'user_target_visible',true,
      'foreign_role_hidden',true,
      'expired_transition','EXPIRED',
      'expired_hidden',true,
      'acknowledged_transition',true,
      'resolved_transition',true,
      'resolved_removed_from_active_center',true,
      'version_after_ack',2,
      'version_after_resolve',3,
      'audit_events',v_audit_count,
      'summary_new_count',(v_summary->>'new_count')::integer,
      'summary_badge_count',(v_summary->>'badge_count')::integer,
      'probe_persisted',false
    );

    raise exception '__ROLLBACK_NOTIFICATION_E2E__'
      using detail=v_evidence::text;

  exception
    when others then
      get stacked diagnostics v_detail=pg_exception_detail;
      if sqlerrm='__ROLLBACK_NOTIFICATION_E2E__' then
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
  'REGRESSION',
  true,
  'Notification Center uses real staff authorization, filters by venue/role/user, expires stale notifications, transitions NEW to ACKNOWLEDGED to RESOLVED, keeps active inbox clean and audits acknowledgement/resolution.'
)
on conflict(key) do nothing;
