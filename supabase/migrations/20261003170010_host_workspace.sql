begin;
create function private.lock_floor(p_venue uuid) returns void language sql volatile security definer set search_path='' as $$
  select pg_advisory_xact_lock(hashtextextended('floor:'||p_venue::text,0))
$$;
create index reservations_host_page on public.reservations(venue_id,service_date,slot_time,id);
create function private.require_booking_enabled(p_venue uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.venue_settings where venue_id=p_venue and reservations_enabled) then raise exception 'RESERVATIONS_DISABLED'; end if;
end $$;
create function public.get_host_reservations(p_venue uuid,p_date date,p_service uuid default null,p_status public.reservation_status default null,p_search text default '',p_after_time time default null,p_after_id uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[],false);
  if p_date is null or p_limit is null or p_limit not between 1 and 100 or length(p_search)>100 or (p_after_time is null)<>(p_after_id is null) then raise exception 'INVALID_FILTER'; end if;
  with filtered as (
    select r.*,t.name as table_name,s.name as service_name from public.reservations r
      join public.services s on s.id=r.service_id left join public.tables t on t.id=r.table_id
    where r.venue_id=p_venue and r.service_date=p_date and (p_service is null or r.service_id=p_service)
      and (p_status is null or r.status=p_status)
      and (coalesce(p_search,'')='' or strpos(lower(r.first_name||' '||r.last_name||' '||r.phone),lower(p_search))>0)
  ), page as (
    select * from filtered where p_after_id is null or (slot_time,id)>(p_after_time,p_after_id) order by slot_time,id limit p_limit+1
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(limited) order by slot_time,id) from (select * from page order by slot_time,id limit p_limit) limited),'[]'),
    'has_more',(select count(*)>p_limit from page),'total',(select count(*) from filtered),
    'covers',(select coalesce(sum(party_size),0) from filtered where status not in ('CANCELLED','NO_SHOW')),
    'arrived',(select count(*) from filtered where status='ARRIVED'),'requested',(select count(*) from filtered where status='REQUESTED')) into result;
  return result;
end $$;

create function public.update_reservation_notes(p_reservation uuid,p_note text,p_allergies text,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if p_version is distinct from r.version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if not r.walk_in then perform private.require_booking_enabled(r.venue_id); end if;
  if coalesce(length(p_note),0)>2000 or coalesce(length(p_allergies),0)>2000 then raise exception 'INVALID_NOTE'; end if;
  update public.reservations set internal_note=nullif(trim(p_note),''),allergies=nullif(trim(p_allergies),'') where id=r.id;
end $$;

-- An explicit joinability graph prevents suggestions from silently assuming tables can be moved together.
create table public.table_join_rules (
  venue_id uuid not null references public.venues(id), first_table_id uuid not null, second_table_id uuid not null,
  primary key(first_table_id,second_table_id), check(first_table_id<second_table_id),
  foreign key(venue_id,first_table_id) references public.tables(venue_id,id), foreign key(venue_id,second_table_id) references public.tables(venue_id,id)
);
alter table public.table_join_rules enable row level security;
grant select on public.table_join_rules to authenticated;
create policy scoped_read on public.table_join_rules for select to authenticated using(private.has_venue(venue_id) and private.is_role(array['ADMIN','HOST']::public.user_role[]));
create trigger audit_change after insert or update or delete on public.table_join_rules for each row execute function private.audit_row();

create function public.configure_table_join(p_first uuid,p_second uuid,p_enabled boolean) returns void language plpgsql security definer set search_path='' as $$
declare first_table public.tables; second_table public.tables;
begin
  perform 1 from public.tables where id in (p_first,p_second) order by id for update;
  select * into first_table from public.tables where id=p_first and active;
  select * into second_table from public.tables where id=p_second and active;
  if first_table.id is null or second_table.id is null or p_first=p_second or first_table.layout_id<>second_table.layout_id then raise exception 'TABLE_FORBIDDEN'; end if;
  perform private.authorize(first_table.venue_id,array['ADMIN']::public.user_role[]);
  if p_enabled then
    insert into public.table_join_rules values(first_table.venue_id,least(p_first,p_second),greatest(p_first,p_second)) on conflict do nothing;
  else delete from public.table_join_rules where first_table_id=least(p_first,p_second) and second_table_id=greatest(p_first,p_second); end if;
end $$;

create function private.table_group(p_table uuid) returns uuid[] language sql stable security definer set search_path='' as $$
  with root as (select coalesce((select primary_table_id from public.table_merges where secondary_table_id=p_table and split_at is null),p_table) id)
  select array_agg(id order by id) from (select id from root union select secondary_table_id from public.table_merges where primary_table_id=(select id from root) and split_at is null) members
$$;

create or replace function public.suggest_tables(p_reservation uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reservations; result jsonb;
begin
  select * into r from public.reservations where id=p_reservation;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[],false);
  with recursive available as (
    select t.* from public.tables t join public.room_layouts l on l.id=t.layout_id and l.active and not l.archived
    where t.venue_id=r.venue_id and t.active and t.technical_status='AVAILABLE'
      and not exists(select 1 from public.accounts a where a.table_id=t.id and a.status<>'CLOSED')
      and not exists(select 1 from public.reservations other where other.table_id=t.id and other.id<>r.id and other.service_date=r.service_date and other.service_id=r.service_id and other.status not in ('COMPLETED','CANCELLED','NO_SHOW'))
  ), candidates as (
    select t.id,private.table_group(t.id) as members,(select sum(a.seats)::integer from available a where a.id=any(private.table_group(t.id))) seats,t.zone_id,t.layout_id
    from available t where not exists(select 1 from public.table_merges where secondary_table_id=t.id and split_at is null)
      and not exists(select 1 from unnest(private.table_group(t.id)) member where not exists(select 1 from available where id=member))
  ), suggestions as (
    select id,members,seats,zone_id,layout_id from candidates
    union all
    select previous.id,previous.members||next.members,previous.seats+next.seats,previous.zone_id,previous.layout_id
    from suggestions previous cross join lateral (
      select c.* from candidates c where c.layout_id=previous.layout_id and not c.members&&previous.members
        and exists(select 1 from public.table_join_rules j where (j.first_table_id=any(previous.members) and j.second_table_id=any(c.members)) or (j.second_table_id=any(previous.members) and j.first_table_id=any(c.members)))
      order by (c.zone_id is not distinct from previous.zone_id) desc,abs((r.party_size-previous.seats)-c.seats),c.id limit 1
    ) next where previous.seats<r.party_size
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'table_ids',s.members,'name',(select string_agg(t.name,' + ' order by t.number) from public.tables t where t.id=any(s.members)),
    'seats',s.seats,'zone_id',s.zone_id,'requires_merge',cardinality(s.members)>cardinality(private.table_group(s.id))) order by s.seats-r.party_size,cardinality(s.members),s.id),'[]')
    into result from suggestions s where s.seats>=r.party_size;
  return result;
end $$;

create or replace function public.merge_tables(p_primary uuid,p_secondary uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare first_table public.tables; second_table public.tables; ref uuid;
begin
  perform private.lock_floor((select venue_id from public.tables where id=p_primary));
  perform 1 from public.tables where id in (p_primary,p_secondary) order by id for update;
  select * into first_table from public.tables where id=p_primary and active;
  select * into second_table from public.tables where id=p_secondary and active;
  if first_table.id is null or second_table.id is null or first_table.id=second_table.id or first_table.layout_id<>second_table.layout_id then raise exception 'TABLE_FORBIDDEN'; end if;
  perform private.authorize(first_table.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if exists(select 1 from public.table_merges where split_at is null and (secondary_table_id in (p_primary,p_secondary) or primary_table_id=p_secondary)) then raise exception 'TABLE_ALREADY_MERGED'; end if;
  if exists(select 1 from public.reservations where table_id=p_secondary and status in ('REQUESTED','RESERVED','ARRIVED','SEATED')) or exists(select 1 from public.accounts where table_id=p_secondary and status<>'CLOSED') then raise exception 'TABLE_STILL_IN_USE'; end if;
  insert into public.table_merges(venue_id,primary_table_id,secondary_table_id) values(first_table.venue_id,p_primary,p_secondary) returning id into ref;
  update public.tables set technical_status=first_table.technical_status where id=p_secondary;
  return ref;
end $$;

create function public.assign_table_group(p_reservation uuid,p_tables uuid[],p_confirm_change boolean,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations; member uuid; primary_table uuid:=p_tables[1];
begin
  perform private.lock_floor((select venue_id from public.reservations where id=p_reservation));
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if primary_table is null or cardinality(p_tables)<>(select count(distinct t) from unnest(p_tables) t) then raise exception 'INVALID_TABLE_GROUP'; end if;
  perform 1 from public.tables where id=any(p_tables) order by id for update;
  foreach member in array p_tables loop
    if not exists(select 1 from public.tables where id=member and venue_id=r.venue_id and active) then raise exception 'TABLE_FORBIDDEN'; end if;
    if member<>primary_table and not member=any(private.table_group(primary_table)) then perform public.merge_tables(primary_table,member); end if;
  end loop;
  perform public.assign_table(r.id,primary_table,p_confirm_change);
end $$;

grant execute on function public.get_host_reservations(uuid,date,uuid,public.reservation_status,text,time,uuid,integer),public.update_reservation_notes(uuid,text,text,bigint),public.configure_table_join(uuid,uuid,boolean),public.assign_table_group(uuid,uuid[],boolean,bigint) to authenticated;
commit;
