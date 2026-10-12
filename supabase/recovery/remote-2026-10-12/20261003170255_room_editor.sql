begin;
create table public.layout_revisions (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), layout_id uuid not null,
  layout_version bigint not null, snapshot jsonb not null, created_by uuid not null references public.staff_profiles(id), created_at timestamptz not null default now(),
  foreign key(venue_id,layout_id) references public.room_layouts(venue_id,id)
);
alter table public.layout_revisions enable row level security;
grant select on public.layout_revisions to authenticated;
create policy revision_read on public.layout_revisions for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN']::public.user_role[]));
create trigger revision_immutable before update or delete on public.layout_revisions for each row execute function private.immutable_record();
create trigger revision_no_truncate before truncate on public.layout_revisions for each statement execute function private.immutable_record();

create function private.layout_editable(p_layout uuid) returns void language plpgsql security definer set search_path='' as $$
declare l public.room_layouts;
begin
  select * into l from public.room_layouts where id=p_layout;
  if l.id is null or l.archived then raise exception 'NOT_FOUND'; end if;
  if exists(select 1 from public.tables t where t.room_id=l.room_id and
    (t.technical_status not in ('AVAILABLE','TO_RESET') or exists(select 1 from public.accounts a where a.table_id=t.id and a.floor_released_at is null)
      or exists(select 1 from public.reservations r where r.table_id=t.id and r.status in ('ARRIVED','SEATED'))
      or exists(select 1 from public.table_merges m where (m.primary_table_id=t.id or m.secondary_table_id=t.id) and m.split_at is null))) then raise exception 'LAYOUT_IN_SERVICE'; end if;
end $$;

create function public.save_room_layout(p_layout uuid,p_version bigint,p_elements jsonb,p_tables jsonb,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.room_layouts; item jsonb; table_row public.tables; kept uuid[]:='{}'; ref uuid; result jsonb;
begin
  select * into l from public.room_layouts where id=p_layout;
  if l.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(l.venue_id,array['ADMIN']::public.user_role[]);
  result:=private.idempotency_begin('save_layout',p_key,jsonb_build_object('layout',p_layout,'version',p_version,'elements',p_elements,'tables',p_tables));
  if result is not null then return result; end if;
  perform 1 from public.rooms where id=l.room_id for update;
  select * into l from public.room_layouts where id=p_layout for update;
  perform 1 from public.tables where room_id=l.room_id order by id for update;
  perform private.layout_editable(l.id);
  if p_version is distinct from l.version then raise exception 'VERSION_CONFLICT'; end if;
  if p_elements is null or p_tables is null or jsonb_typeof(p_elements)<>'array' or jsonb_typeof(p_tables)<>'array'
    or jsonb_array_length(p_elements)>1000 or jsonb_array_length(p_tables)>500 or length(p_elements::text)>1000000 then raise exception 'INVALID_LAYOUT'; end if;
  for item in select value from jsonb_array_elements(p_elements) loop
    if not item ?& array['id','kind','x','y','width','height','rotation','color','layer'] or item-array['id','kind','x','y','width','height','rotation','text','color','layer']<>'{}'::jsonb
      or item->>'kind' not in ('WALL','DOOR','WINDOW','COUNTER','RECTANGLE','ELLIPSE','DECOR','TEXT','ZONE')
      or (item->>'id')::uuid is null or length(coalesce(item->>'text',''))>300 or coalesce(item->>'color','') !~ '^#[0-9A-Fa-f]{6}$'
      or (item->>'x')::numeric not between 0 and l.width or (item->>'y')::numeric not between 0 and l.height
      or (item->>'width')::numeric not between 1 and l.width or (item->>'height')::numeric not between 1 and l.height
      or (item->>'rotation')::numeric not between -360 and 360 or (item->>'layer')::integer not between -10000 and 10000 then raise exception 'INVALID_LAYOUT'; end if;
    if exists(select 1 from jsonb_each(item) x where x.key in ('x','y','width','height','rotation','layer') and jsonb_typeof(x.value)<>'number') then raise exception 'INVALID_LAYOUT'; end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_elements))<>jsonb_array_length(p_elements) then raise exception 'INVALID_LAYOUT'; end if;
  insert into public.layout_revisions(venue_id,layout_id,layout_version,snapshot,created_by)
    values(l.venue_id,l.id,l.version,jsonb_build_object('layout',to_jsonb(l),'tables',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from public.tables t where layout_id=l.id)),private.effective_user_id());
  for item in select value from jsonb_array_elements(p_tables) loop
    if item-array['id','version','name','number','seats','zone_id','shape','position_x','position_y','width','height','rotation']<>'{}'::jsonb
      or (item->>'position_x')::numeric not between 0 and l.width or (item->>'position_y')::numeric not between 0 and l.height
      or (item->>'width')::numeric not between 20 and l.width or (item->>'height')::numeric not between 20 and l.height
      or (item->>'rotation')::numeric not between -360 and 360 then raise exception 'INVALID_LAYOUT'; end if;
    ref:=(item->>'id')::uuid;
    if ref is null or ref=any(kept) then raise exception 'INVALID_LAYOUT'; end if;
    kept:=array_append(kept,ref);
    select * into table_row from public.tables where id=ref for update;
    if table_row.id is not null then
      if table_row.layout_id<>l.id or table_row.version is distinct from (item->>'version')::bigint then raise exception 'VERSION_CONFLICT'; end if;
      update public.tables set name=item->>'name',number=(item->>'number')::integer,seats=(item->>'seats')::integer,zone_id=(item->>'zone_id')::uuid,
        shape=item->>'shape',position_x=(item->>'position_x')::numeric,position_y=(item->>'position_y')::numeric,width=(item->>'width')::numeric,height=(item->>'height')::numeric,rotation=(item->>'rotation')::numeric,active=true where id=ref;
    else
      insert into public.tables(id,venue_id,room_id,layout_id,name,number,seats,zone_id,shape,position_x,position_y,width,height,rotation)
        values(ref,l.venue_id,l.room_id,l.id,item->>'name',(item->>'number')::integer,(item->>'seats')::integer,(item->>'zone_id')::uuid,item->>'shape',(item->>'position_x')::numeric,(item->>'position_y')::numeric,(item->>'width')::numeric,(item->>'height')::numeric,(item->>'rotation')::numeric);
    end if;
  end loop;
  update public.tables set active=false where layout_id=l.id and active and not id=any(kept);
  update public.room_layouts set elements=p_elements where id=l.id;
  perform private.audit('ROOM_LAYOUT_SAVED','room_layouts',l.id,l.venue_id,jsonb_build_object('version',l.version),jsonb_build_object('elements',jsonb_array_length(p_elements),'tables',cardinality(kept)));
  select jsonb_build_object('layout',to_jsonb(rl),'tables',(select coalesce(jsonb_agg(to_jsonb(t) order by number),'[]') from public.tables t where t.layout_id=l.id and active)) into result from public.room_layouts rl where id=l.id;
  return private.idempotency_finish('save_layout',p_key,result);
end $$;
grant execute on function public.save_room_layout(uuid,bigint,jsonb,jsonb,uuid) to authenticated;

create function public.activate_room_layout(p_layout uuid,p_version bigint,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.room_layouts; result jsonb;
begin
  select * into l from public.room_layouts where id=p_layout;
  if l.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(l.venue_id,array['ADMIN']::public.user_role[]);
  perform 1 from public.rooms where id=l.room_id for update;
  perform 1 from public.room_layouts where room_id=l.room_id order by id for update;
  perform 1 from public.tables where room_id=l.room_id order by id for update;
  result:=private.idempotency_begin('activate_layout',p_key,jsonb_build_object('layout',p_layout,'version',p_version));
  if result is not null then return result; end if;
  perform private.layout_editable(l.id);
  if l.version is distinct from p_version then raise exception 'VERSION_CONFLICT'; end if;
  update public.room_layouts set active=false where room_id=l.room_id and active and id<>l.id;
  update public.room_layouts set active=true where id=l.id;
  perform private.audit('ROOM_LAYOUT_ACTIVATED','room_layouts',l.id,l.venue_id);
  return private.idempotency_finish('activate_layout',p_key,jsonb_build_object('id',l.id));
end $$;
grant execute on function public.activate_room_layout(uuid,bigint,uuid) to authenticated;
commit;
