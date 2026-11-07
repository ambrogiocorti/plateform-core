
create or replace function private.test_room_editor_advanced_contract()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user constant uuid:='d05b9ce5-1049-4622-bb49-35ebef2c777a'::uuid;
  v_session constant uuid:='15e44a65-d47e-42f8-a5bf-77dd13c6540e'::uuid;
  v_venue constant uuid:='8241033e-7053-44d3-9427-fbf7ea72e684'::uuid;
  v_room uuid; v_zone uuid; v_layout uuid; v_table uuid:=gen_random_uuid();
  v_workspace jsonb; v_room_error text; v_zone_error text; v_archive_error text;
  v_detail text; v_evidence jsonb;
begin
  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub',v_user::text,'session_id',v_session::text,
        'iat',extract(epoch from clock_timestamp())::bigint,
        'aal','aal2','role','authenticated',
        'amr',jsonb_build_array(jsonb_build_object(
          'method','password','timestamp',extract(epoch from clock_timestamp())::bigint
        ))
      )::text,true
    );
    perform set_config('request.headers','{}',true);
    update private.staff_sessions set unlocked_until=clock_timestamp()+interval '30 minutes'
      where session_id=v_session and user_id=v_user and revoked_at is null;
    insert into public.staff_venue_assignments(user_id,venue_id,active)
      values(v_user,v_venue,true)
      on conflict(user_id,venue_id) do update set active=true;
    update public.feature_flags set licensed=true where name='ADVANCED_ROOM_EDITOR';

    v_room:=(public.save_room(v_venue,null,null,'E2E Editor Room',true,gen_random_uuid())->>'id')::uuid;
    v_zone:=(public.save_zone(v_room,null,null,'E2E Editor Zone','#B88A55',true,gen_random_uuid())->>'id')::uuid;
    v_layout:=(public.create_room_layout(v_room,'E2E Editor Layout',900,600,gen_random_uuid())->>'id')::uuid;

    perform public.save_room_layout(
      v_layout,(select version from public.room_layouts where id=v_layout),
      jsonb_build_array(jsonb_build_object(
        'id',gen_random_uuid(),'kind','WALL','x',10,'y',10,'width',200,'height',12,
        'rotation',0,'text','','color','#B88A55','layer',0
      )),
      jsonb_build_array(jsonb_build_object(
        'id',v_table,'version',1,'name','E2E Tavolo','number',999,'seats',4,
        'zone_id',v_zone,'shape','RECTANGLE','position_x',100,'position_y',100,
        'width',90,'height',70,'rotation',0
      )),
      gen_random_uuid()
    );

    perform public.activate_room_layout(
      v_layout,(select version from public.room_layouts where id=v_layout),gen_random_uuid()
    );

    v_workspace:=public.get_room_editor_workspace(v_venue);
    if not exists(
      select 1 from jsonb_array_elements(v_workspace->'rooms') r
      cross join lateral jsonb_array_elements(r->'layouts') l
      cross join lateral jsonb_array_elements(l->'tables') t
      where (r->>'id')::uuid=v_room
        and (l->>'id')::uuid=v_layout
        and (l->>'active')::boolean
        and (t->>'id')::uuid=v_table
    ) then raise exception 'ROOM_EDITOR_WORKSPACE_FAILED'; end if;

    begin
      perform public.save_room(v_venue,v_room,(select version from public.rooms where id=v_room),'E2E Editor Room',false,gen_random_uuid());
      v_room_error:='NO_ERROR';
    exception when others then v_room_error:=sqlerrm; end;

    begin
      perform public.save_zone(v_room,v_zone,(select version from public.zones where id=v_zone),'E2E Editor Zone','#B88A55',false,gen_random_uuid());
      v_zone_error:='NO_ERROR';
    exception when others then v_zone_error:=sqlerrm; end;

    begin
      perform public.archive_room_layout(v_layout,(select version from public.room_layouts where id=v_layout),gen_random_uuid());
      v_archive_error:='NO_ERROR';
    exception when others then v_archive_error:=sqlerrm; end;

    if v_room_error<>'ROOM_IN_USE'
       or v_zone_error<>'ZONE_IN_USE'
       or v_archive_error<>'ACTIVE_LAYOUT_CANNOT_BE_ARCHIVED'
    then raise exception 'ROOM_EDITOR_GUARD_FAILED'; end if;

    v_evidence:=jsonb_build_object(
      'room_created',true,'zone_created',true,'layout_created',true,
      'layout_saved_with_table_and_element',true,'layout_activated',true,
      'workspace_readback',true,'room_in_use_guard',v_room_error,
      'zone_in_use_guard',v_zone_error,'active_layout_archive_guard',v_archive_error,
      'probe_persisted',false
    );
    raise exception '__ROLLBACK_ROOM_EDITOR_TEST__' using detail=v_evidence::text;
  exception when others then
    get stacked diagnostics v_detail=pg_exception_detail;
    if sqlerrm='__ROLLBACK_ROOM_EDITOR_TEST__' then return v_detail::jsonb; end if;
    raise;
  end;
end
$$;
