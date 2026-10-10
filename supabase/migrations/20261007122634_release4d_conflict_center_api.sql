
create or replace function public.get_conflict_center(
  p_venue uuid,
  p_status text default 'OPEN',
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
begin
  if p_venue is null
     or p_limit is null
     or p_limit not between 1 and 200
     or p_status not in ('OPEN','RESOLVED','DISCARDED','ALL')
  then
    raise exception 'INVALID_FILTER';
  end if;

  v_actor:=private.authorize(
    p_venue,
    array['ADMIN']::public.user_role[]
  );

  return jsonb_build_object(
    'items',
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id desc)
      from (
        select
          c.id,
          c.venue_id,
          c.status,
          c.reason_code,
          c.created_at,
          c.resolved_at,
          c.resolved_by,
          c.resolution,
          c.server_snapshot,
          e.id as sync_event_id,
          e.client_event_id,
          e.resource_type,
          e.resource_id,
          e.operation,
          e.base_version,
          e.payload as requested_payload,
          e.created_at_local,
          e.received_at,
          e.synced_at,
          e.sync_status::text as sync_status,
          e.user_id,
          sp.display_name as user_display_name,
          e.device_id,
          d.display_name as device_display_name,
          d.platform as device_platform,
          case
            when c.status='OPEN'
              then jsonb_build_array('ACKNOWLEDGE','DISCARD')
            else '[]'::jsonb
          end as safe_actions
        from public.sync_conflicts c
        join public.offline_sync_events e
          on e.id=c.sync_event_id
         and e.venue_id=c.venue_id
        left join public.staff_profiles sp
          on sp.id=e.user_id
        left join public.registered_devices d
          on d.id=e.device_id
         and d.user_id=e.user_id
         and d.venue_id=e.venue_id
        where c.venue_id=p_venue
          and (p_status='ALL' or c.status=p_status)
        order by c.created_at desc,c.id desc
        limit p_limit
      ) x
    ),'[]'::jsonb),
    'viewer_user_id',
    v_actor
  );
end
$$;

revoke all on function public.get_conflict_center(uuid,text,integer)
from public,anon;
grant execute on function public.get_conflict_center(uuid,text,integer)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.get_conflict_center(uuid,text,integer)',
  'authenticated'
)
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'CONFLICT_CENTER_E2E',
  'E2E',
  true,
  'Admin-only Conflict Center exposes venue/resource/user/device/local+sync times/reason/server snapshot/requested operation/safe actions and resolution rejects the original offline event with audit.'
)
on conflict(key) do nothing;
