
create or replace function public.get_room_editor_workspace(p_venue uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[],false);

  return jsonb_build_object(
    'rooms',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',r.id,'name',r.name,'active',r.active,'version',r.version,
          'zones',coalesce((
            select jsonb_agg(jsonb_build_object(
              'id',z.id,'name',z.name,'color',z.color,'active',z.active,'version',z.version
            ) order by z.name,z.id)
            from public.zones z where z.room_id=r.id
          ),'[]'::jsonb),
          'layouts',coalesce((
            select jsonb_agg(jsonb_build_object(
              'id',l.id,'name',l.name,'active',l.active,'archived',l.archived,
              'width',l.width,'height',l.height,'elements',l.elements,'version',l.version,
              'tables',coalesce((
                select jsonb_agg(to_jsonb(t) order by t.number,t.id)
                from public.tables t where t.layout_id=l.id and t.active
              ),'[]'::jsonb),
              'revisions',coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id',rv.id,'layout_version',rv.layout_version,'created_at',rv.created_at,'created_by',rv.created_by
                ) order by rv.created_at desc,rv.id desc)
                from (
                  select * from public.layout_revisions
                  where layout_id=l.id
                  order by created_at desc,id desc
                  limit 20
                ) rv
              ),'[]'::jsonb)
            ) order by l.active desc,l.name,l.id)
            from public.room_layouts l where l.room_id=r.id and not l.archived
          ),'[]'::jsonb)
        )
        order by r.name,r.id
      )
      from public.rooms r
      where r.venue_id=p_venue
    ),'[]'::jsonb)
  );
end
$$;

create or replace function public.save_room(
  p_venue uuid,p_id uuid,p_version bigint,p_name text,p_active boolean,p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_room public.rooms;
  v_result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 120 or p_active is null
  then raise exception 'INVALID_ROOM'; end if;

  v_result:=private.idempotency_begin('room_configuration',p_key,jsonb_build_object(
    'venue',p_venue,'id',p_id,'version',p_version,'name',trim(p_name),'active',p_active
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.rooms(id,venue_id,name,active)
    values(v_id,p_venue,trim(p_name),p_active)
    returning * into v_room;
  else
    select * into v_room from public.rooms where id=p_id and venue_id=p_venue for update;
    if v_room.id is null then raise exception 'NOT_FOUND'; end if;
    if v_room.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if not p_active and exists(select 1 from public.tables t where t.room_id=p_id and t.active) then
      raise exception 'ROOM_IN_USE';
    end if;
    update public.rooms set name=trim(p_name),active=p_active where id=p_id returning * into v_room;
  end if;

  perform private.audit(
    case when p_id is null then 'ROOM_CREATED' else 'ROOM_UPDATED' end,
    'rooms',v_room.id,p_venue,null,jsonb_build_object('name',v_room.name,'active',v_room.active)
  );
  v_result:=jsonb_build_object('id',v_room.id,'version',v_room.version);
  return private.idempotency_finish('room_configuration',p_key,v_result);
end
$$;

create or replace function public.save_zone(
  p_room uuid,p_id uuid,p_version bigint,p_name text,p_color text,p_active boolean,p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_room public.rooms;
  v_zone public.zones;
  v_id uuid:=coalesce(p_id,gen_random_uuid());
  v_result jsonb;
begin
  select * into v_room from public.rooms where id=p_room;
  if v_room.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(v_room.venue_id,array['ADMIN']::public.user_role[]);
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 120
     or p_color is null or p_color !~ '^#[0-9A-Fa-f]{6}$' or p_active is null
  then raise exception 'INVALID_ZONE'; end if;

  v_result:=private.idempotency_begin('zone_configuration',p_key,jsonb_build_object(
    'room',p_room,'id',p_id,'version',p_version,'name',trim(p_name),'color',upper(p_color),'active',p_active
  ));
  if v_result is not null then return v_result; end if;

  if p_id is null then
    insert into public.zones(id,venue_id,room_id,name,color,active)
    values(v_id,v_room.venue_id,p_room,trim(p_name),upper(p_color),p_active)
    returning * into v_zone;
  else
    select * into v_zone from public.zones where id=p_id and room_id=p_room for update;
    if v_zone.id is null then raise exception 'NOT_FOUND'; end if;
    if v_zone.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
    if not p_active and exists(select 1 from public.tables where zone_id=p_id and active) then raise exception 'ZONE_IN_USE'; end if;
    update public.zones set name=trim(p_name),color=upper(p_color),active=p_active where id=p_id returning * into v_zone;
  end if;

  perform private.audit(
    case when p_id is null then 'ZONE_CREATED' else 'ZONE_UPDATED' end,
    'zones',v_zone.id,v_room.venue_id,null,jsonb_build_object('room_id',p_room,'name',v_zone.name,'active',v_zone.active)
  );
  v_result:=jsonb_build_object('id',v_zone.id,'version',v_zone.version);
  return private.idempotency_finish('zone_configuration',p_key,v_result);
end
$$;

create or replace function public.create_room_layout(
  p_room uuid,p_name text,p_width integer,p_height integer,p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_room public.rooms;
  v_layout public.room_layouts;
  v_result jsonb;
begin
  select * into v_room from public.rooms where id=p_room for update;
  if v_room.id is null or not v_room.active then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(v_room.venue_id,array['ADMIN']::public.user_role[]);
  if p_key is null or p_name is null or length(trim(p_name)) not between 1 and 120
     or p_width not between 300 and 5000 or p_height not between 300 and 5000
  then raise exception 'INVALID_LAYOUT'; end if;

  v_result:=private.idempotency_begin('create_layout',p_key,jsonb_build_object(
    'room',p_room,'name',trim(p_name),'width',p_width,'height',p_height
  ));
  if v_result is not null then return v_result; end if;

  if (select count(*) from public.room_layouts where room_id=p_room and not archived)>=20 then
    raise exception 'LAYOUT_LIMIT_REACHED';
  end if;

  insert into public.room_layouts(venue_id,room_id,name,width,height,active,elements)
  values(v_room.venue_id,p_room,trim(p_name),p_width,p_height,false,'[]'::jsonb)
  returning * into v_layout;

  perform private.audit('ROOM_LAYOUT_CREATED','room_layouts',v_layout.id,v_room.venue_id,null,jsonb_build_object(
    'room_id',p_room,'width',p_width,'height',p_height
  ));
  v_result:=jsonb_build_object('id',v_layout.id,'version',v_layout.version);
  return private.idempotency_finish('create_layout',p_key,v_result);
end
$$;

create or replace function public.archive_room_layout(
  p_layout uuid,p_version bigint,p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_layout public.room_layouts;
  v_result jsonb;
begin
  select * into v_layout from public.room_layouts where id=p_layout for update;
  if v_layout.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(v_layout.venue_id,array['ADMIN']::public.user_role[]);
  v_result:=private.idempotency_begin('archive_layout',p_key,jsonb_build_object('layout',p_layout,'version',p_version));
  if v_result is not null then return v_result; end if;
  perform private.layout_editable(v_layout.id);
  if v_layout.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if v_layout.active then raise exception 'ACTIVE_LAYOUT_CANNOT_BE_ARCHIVED'; end if;
  update public.room_layouts set archived=true where id=p_layout returning * into v_layout;
  update public.tables set active=false where layout_id=p_layout and active;
  perform private.audit('ROOM_LAYOUT_ARCHIVED','room_layouts',v_layout.id,v_layout.venue_id);
  v_result:=jsonb_build_object('id',v_layout.id,'version',v_layout.version);
  return private.idempotency_finish('archive_layout',p_key,v_result);
end
$$;

revoke all on function public.get_room_editor_workspace(uuid) from public,anon;
revoke all on function public.save_room(uuid,uuid,bigint,text,boolean,uuid) from public,anon;
revoke all on function public.save_zone(uuid,uuid,bigint,text,text,boolean,uuid) from public,anon;
revoke all on function public.create_room_layout(uuid,text,integer,integer,uuid) from public,anon;
revoke all on function public.archive_room_layout(uuid,bigint,uuid) from public,anon;
grant execute on function public.get_room_editor_workspace(uuid) to authenticated,service_role;
grant execute on function public.save_room(uuid,uuid,bigint,text,boolean,uuid) to authenticated,service_role;
grant execute on function public.save_zone(uuid,uuid,bigint,text,text,boolean,uuid) to authenticated,service_role;
grant execute on function public.create_room_layout(uuid,text,integer,integer,uuid) to authenticated,service_role;
grant execute on function public.archive_room_layout(uuid,bigint,uuid) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
('public.get_room_editor_workspace(uuid)','authenticated'),
('public.save_room(uuid,uuid,bigint,text,boolean,uuid)','authenticated'),
('public.save_zone(uuid,uuid,bigint,text,text,boolean,uuid)','authenticated'),
('public.create_room_layout(uuid,text,integer,integer,uuid)','authenticated'),
('public.archive_room_layout(uuid,bigint,uuid)','authenticated')
on conflict do nothing;
