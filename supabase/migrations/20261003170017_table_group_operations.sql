begin;
create or replace function public.assign_table(p_reservation uuid,p_table uuid,p_confirm_change boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations; t public.tables; capacity integer; members uuid[];
begin
  perform private.lock_floor((select venue_id from public.reservations where id=p_reservation));
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if not r.walk_in then perform private.require_booking_enabled(r.venue_id); end if;
  members:=private.table_group(p_table);
  perform 1 from public.tables where id=any(members) order by id for update;
  select * into t from public.tables where id=p_table and venue_id=r.venue_id and active;
  if t.id is null or exists(select 1 from public.table_merges where secondary_table_id=t.id and split_at is null)
    or not exists(select 1 from public.room_layouts where id=t.layout_id and active and not archived) then raise exception 'TABLE_FORBIDDEN'; end if;
  if r.status not in ('REQUESTED','RESERVED','ARRIVED') then raise exception 'RESERVATION_NOT_ASSIGNABLE'; end if;
  if r.table_id is not null and r.table_id<>t.id and p_confirm_change is distinct from true then raise exception 'CONFIRM_TABLE_CHANGE'; end if;
  if exists(select 1 from public.tables where id=any(members) and technical_status not in ('AVAILABLE','RESERVED','ARRIVING'))
    or exists(select 1 from public.accounts where table_id=any(members) and status<>'CLOSED') then raise exception 'TABLE_NOT_AVAILABLE'; end if;
  if exists(select 1 from public.reservations where table_id=any(members) and id<>r.id and service_id=r.service_id and service_date=r.service_date and status not in ('CANCELLED','NO_SHOW','COMPLETED')) then raise exception 'TABLE_ALREADY_RESERVED'; end if;
  select sum(seats) into capacity from public.tables where id=any(members) and active;
  if capacity<r.party_size then raise exception 'TABLE_CAPACITY_INSUFFICIENT'; end if;
  update public.reservations set table_id=t.id where id=r.id;
  update public.tables set technical_status=case when r.status='ARRIVED' then 'ARRIVING'::public.table_status else 'RESERVED'::public.table_status end where id=any(members);
end $$;

create or replace function public.transition_reservation(p_reservation uuid,p_status public.reservation_status,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations; members uuid[];
begin
  perform private.lock_floor((select venue_id from public.reservations where id=p_reservation));
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if not r.walk_in then perform private.require_booking_enabled(r.venue_id); end if;
  if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if p_status is null or not ((r.status='REQUESTED' and p_status in ('RESERVED','CANCELLED')) or (r.status='RESERVED' and p_status in ('ARRIVED','CANCELLED','NO_SHOW'))
    or (r.status='ARRIVED' and p_status in ('SEATED','CANCELLED')) or (r.status='SEATED' and p_status='COMPLETED')) then raise exception 'INVALID_TRANSITION'; end if;
  if p_status='SEATED' and r.table_id is null then raise exception 'TABLE_ASSIGNMENT_REQUIRED'; end if;
  members:=private.table_group(r.table_id);
  perform 1 from public.tables where id=any(members) order by id for update;
  if p_status='COMPLETED' and exists(select 1 from public.accounts where table_id=any(members) and status<>'CLOSED') then raise exception 'TABLE_HAS_OPEN_ACCOUNTS'; end if;
  update public.reservations set status=p_status,arrived_at=case when p_status='ARRIVED' then now() else arrived_at end,
    seated_at=case when p_status='SEATED' then now() else seated_at end,completed_at=case when p_status='COMPLETED' then now() else completed_at end where id=r.id;
  if p_status='ARRIVED' and r.table_id is not null then update public.tables set technical_status='ARRIVING' where id=any(members);
  elsif p_status='SEATED' then update public.tables set technical_status='OCCUPIED' where id=any(members);
  elsif p_status='COMPLETED' then update public.tables set technical_status='TO_RESET' where id=any(members); end if;
end $$;

create or replace function public.set_table_available(p_table uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.tables; members uuid[];
begin
  perform private.lock_floor((select venue_id from public.tables where id=p_table));
  select * into t from public.tables where id=p_table;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(t.venue_id,array['ADMIN','HOST','WAITER']::public.user_role[]);
  if private.current_role()='WAITER' and private.responsible_waiter(t.id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED'; end if;
  members:=private.table_group(t.id);
  perform 1 from public.tables where id=any(members) order by id for update;
  if exists(select 1 from public.accounts where table_id=any(members) and status<>'CLOSED') or exists(select 1 from public.reservations where table_id=any(members) and status in ('ARRIVED','SEATED')) then raise exception 'TABLE_STILL_IN_USE'; end if;
  update public.tables set technical_status='AVAILABLE' where id=any(members);
end $$;

create or replace function public.split_tables(p_primary uuid) returns void language plpgsql security definer set search_path='' as $$
declare venue uuid; members uuid[];
begin
  select venue_id into venue from public.tables where id=p_primary;
  if venue is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(venue,array['ADMIN','HOST']::public.user_role[]);
  perform private.lock_floor(venue);
  members:=private.table_group(p_primary);
  perform 1 from public.tables where id=any(members) order by id for update;
  if exists(select 1 from public.accounts where status<>'CLOSED' and table_id=any(members))
    or exists(select 1 from public.reservations where table_id=any(members) and status in ('REQUESTED','RESERVED','ARRIVED','SEATED')) then raise exception 'TABLE_GROUP_IN_SERVICE'; end if;
  update public.table_merges set split_at=now() where primary_table_id=p_primary and split_at is null;
end $$;

create or replace function public.move_table(p_from uuid,p_to uuid,p_confirm boolean) returns void language plpgsql security definer set search_path='' as $$
declare old_table public.tables; new_table public.tables; waiter uuid; source_members uuid[]; target_members uuid[]; required_seats integer;
begin
  if p_confirm is distinct from true or p_from=p_to then raise exception 'CONFIRM_TABLE_CHANGE'; end if;
  select * into old_table from public.tables where id=p_from and active;
  if old_table.id is null then raise exception 'TABLE_FORBIDDEN'; end if;
  perform private.authorize(old_table.venue_id,array['ADMIN','HOST']::public.user_role[]);
  perform private.lock_floor(old_table.venue_id);
  source_members:=private.table_group(p_from); target_members:=private.table_group(p_to);
  if source_members&&target_members or exists(select 1 from public.table_merges where secondary_table_id in (p_from,p_to) and split_at is null) then raise exception 'SELECT_PRIMARY_TABLE'; end if;
  perform 1 from public.tables where id=any(source_members||target_members) order by id for update;
  select * into old_table from public.tables where id=p_from and active;
  select * into new_table from public.tables where id=p_to and active and venue_id=old_table.venue_id;
  if new_table.id is null or not exists(select 1 from public.room_layouts where id=new_table.layout_id and active and not archived) then raise exception 'TABLE_FORBIDDEN'; end if;
  if exists(select 1 from public.tables where id=any(target_members) and (not active or technical_status<>'AVAILABLE'))
    or exists(select 1 from public.accounts where table_id=any(target_members) and status<>'CLOSED')
    or exists(select 1 from public.reservations where table_id=any(target_members) and status in ('REQUESTED','RESERVED','ARRIVED','SEATED')) then raise exception 'TARGET_TABLE_NOT_AVAILABLE'; end if;
  perform 1 from public.accounts where table_id=any(source_members||target_members) order by id for update;
  -- A seated reservation and its account describe the same guests; do not double-count them.
  select greatest(coalesce((select sum(covers) from public.accounts where table_id=any(source_members) and status<>'CLOSED'),0),
    coalesce((select sum(party_size) from public.reservations where table_id=any(source_members) and status in ('ARRIVED','SEATED')),0)) into required_seats;
  if required_seats=0 then raise exception 'SOURCE_TABLE_EMPTY'; end if;
  if (select sum(seats) from public.tables where id=any(target_members))<required_seats then raise exception 'TABLE_CAPACITY_INSUFFICIENT'; end if;
  waiter:=private.responsible_waiter(p_from);
  update public.accounts set table_id=p_to where table_id=any(source_members) and status<>'CLOSED';
  update private.customer_sessions set table_id=p_to where table_id=any(source_members) and revoked_at is null and account_id in(select id from public.accounts where table_id=p_to and status<>'CLOSED');
  update public.waiter_calls set table_id=p_to where table_id=any(source_members) and status<>'COMPLETED';
  update public.reservations set table_id=p_to where table_id=any(source_members) and status in ('ARRIVED','SEATED');
  if waiter is not null then
    update public.table_assignments set active=false where table_id=any(target_members) and active;
    insert into public.table_assignments(venue_id,waiter_id,mode,table_id) select old_table.venue_id,waiter,'TABLE',unnest(target_members);
  end if;
  update public.tables set technical_status=old_table.technical_status where id=any(target_members);
  update public.tables set technical_status='TO_RESET' where id=any(source_members);
  perform private.audit('TABLE_MOVED','tables',p_to,old_table.venue_id,jsonb_build_object('table_id',p_from),jsonb_build_object('table_id',p_to));
end $$;
commit;
