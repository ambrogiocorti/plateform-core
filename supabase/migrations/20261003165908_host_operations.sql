begin;
create function public.transition_reservation(p_reservation uuid,p_status public.reservation_status,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if r.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if not ((r.status='REQUESTED' and p_status in ('RESERVED','CANCELLED')) or (r.status='RESERVED' and p_status in ('ARRIVED','CANCELLED','NO_SHOW'))
    or (r.status='ARRIVED' and p_status in ('SEATED','CANCELLED')) or (r.status='SEATED' and p_status='COMPLETED')) then raise exception 'INVALID_TRANSITION'; end if;
  if p_status='SEATED' and r.table_id is null then raise exception 'TABLE_ASSIGNMENT_REQUIRED'; end if;
  if p_status='COMPLETED' and exists(select 1 from public.accounts where table_id=r.table_id and status<>'CLOSED') then raise exception 'TABLE_HAS_OPEN_ACCOUNTS'; end if;
  update public.reservations set status=p_status,arrived_at=case when p_status='ARRIVED' then now() else arrived_at end,
    seated_at=case when p_status='SEATED' then now() else seated_at end,completed_at=case when p_status='COMPLETED' then now() else completed_at end where id=r.id;
  if p_status='ARRIVED' and r.table_id is not null then update public.tables set technical_status='ARRIVING' where id=r.table_id;
  elsif p_status='SEATED' then update public.tables set technical_status='OCCUPIED' where id=r.table_id;
  elsif p_status='COMPLETED' then update public.tables set technical_status='TO_RESET' where id=r.table_id;
  end if;
end $$;
create function public.assign_table(p_reservation uuid,p_table uuid,p_confirm_change boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare r public.reservations; t public.tables; capacity integer;
begin
  select * into r from public.reservations where id=p_reservation for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[]);
  select * into t from public.tables where id=p_table and venue_id=r.venue_id and active for update;
  if t.id is null then raise exception 'TABLE_FORBIDDEN'; end if;
  if r.status not in ('REQUESTED','RESERVED','ARRIVED') then raise exception 'RESERVATION_NOT_ASSIGNABLE'; end if;
  if r.table_id is not null and r.table_id<>t.id and not p_confirm_change then raise exception 'CONFIRM_TABLE_CHANGE'; end if;
  if t.technical_status not in ('AVAILABLE','RESERVED','ARRIVING') or exists(select 1 from public.accounts where table_id=t.id and status<>'CLOSED') then raise exception 'TABLE_NOT_AVAILABLE'; end if;
  if exists(select 1 from public.reservations where table_id=t.id and id<>r.id and service_id=r.service_id and service_date=r.service_date and status not in ('CANCELLED','NO_SHOW','COMPLETED')) then raise exception 'TABLE_ALREADY_RESERVED'; end if;
  select t.seats+coalesce(sum(secondary.seats),0) into capacity from public.table_merges m join public.tables secondary on secondary.id=m.secondary_table_id where m.primary_table_id=t.id and m.split_at is null;
  if capacity<r.party_size then raise exception 'TABLE_CAPACITY_INSUFFICIENT'; end if;
  update public.reservations set table_id=t.id where id=r.id;
  update public.tables set technical_status=case when r.status='ARRIVED' then 'ARRIVING'::public.table_status else 'RESERVED'::public.table_status end where id=t.id;
end $$;
create function public.create_walk_in(p_venue uuid,p_service uuid,p_party integer,p_name text,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare local_now timestamp; ref uuid; result jsonb;
begin
  perform private.authorize(p_venue,array['ADMIN','HOST']::public.user_role[]);
  result:=private.idempotency_begin('walk_in',p_key,jsonb_build_object('venue',p_venue,'service',p_service,'party',p_party,'name',p_name));
  if result is not null then return result; end if;
  perform 1 from public.services where id=p_service and venue_id=p_venue and active for update;
  if not found then raise exception 'SERVICE_UNAVAILABLE'; end if;
  select now() at time zone timezone into local_now from public.venues where id=p_venue;
  insert into public.reservations(venue_id,service_id,service_date,slot_time,first_name,last_name,phone,party_size,status,walk_in,arrived_at)
    values(p_venue,p_service,local_now::date,local_now::time,coalesce(nullif(trim(p_name),''),'Walk-in'),'','',p_party,'ARRIVED',true,now()) returning id into ref;
  return private.idempotency_finish('walk_in',p_key,jsonb_build_object('id',ref));
end $$;
create function public.suggest_tables(p_reservation uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id=p_reservation;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[],false);
  return coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'seats',t.seats,'zone_id',t.zone_id) order by t.seats-r.party_size,t.number)
    from public.tables t join public.room_layouts l on l.id=t.layout_id and l.active and not l.archived
    where t.venue_id=r.venue_id and t.active and t.technical_status='AVAILABLE' and t.seats>=r.party_size
      and not exists(select 1 from public.accounts a where a.table_id=t.id and a.status<>'CLOSED')
      and not exists(select 1 from public.reservations other where other.table_id=t.id and other.id<>r.id and other.service_date=r.service_date and other.service_id=r.service_id and other.status not in ('COMPLETED','CANCELLED','NO_SHOW'))),'[]');
end $$;

create function public.set_table_available(p_table uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.tables;
begin
  select * into t from public.tables where id=p_table for update;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(t.venue_id,array['ADMIN','HOST','WAITER']::public.user_role[]);
  if private.current_role()='WAITER' and private.responsible_waiter(t.id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED'; end if;
  if exists(select 1 from public.accounts where table_id=t.id and status<>'CLOSED') or exists(select 1 from public.reservations where table_id=t.id and status in ('ARRIVED','SEATED')) then raise exception 'TABLE_STILL_IN_USE'; end if;
  update public.tables set technical_status='AVAILABLE' where id=t.id;
end $$;
create function public.move_table(p_from uuid,p_to uuid,p_confirm boolean) returns void language plpgsql security definer set search_path='' as $$
declare old_table public.tables; new_table public.tables; waiter uuid;
begin
  if not p_confirm or p_from=p_to then raise exception 'CONFIRM_TABLE_CHANGE'; end if;
  perform 1 from public.tables where id in (p_from,p_to) order by id for update;
  select * into old_table from public.tables where id=p_from and active;
  select * into new_table from public.tables where id=p_to and active;
  if old_table.id is null or new_table.id is null or old_table.venue_id<>new_table.venue_id then raise exception 'TABLE_FORBIDDEN'; end if;
  perform private.authorize(old_table.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if new_table.technical_status<>'AVAILABLE' or exists(select 1 from public.accounts where table_id=p_to and status<>'CLOSED') then raise exception 'TARGET_TABLE_NOT_AVAILABLE'; end if;
  if exists(select 1 from public.table_merges where split_at is null and (primary_table_id in (p_from,p_to) or secondary_table_id in (p_from,p_to))) then raise exception 'SPLIT_GROUP_BEFORE_MOVING'; end if;
  perform 1 from public.accounts where table_id in (p_from,p_to) order by id for update;
  if new_table.seats<(select coalesce(sum(covers),0) from public.accounts where table_id=p_from and status<>'CLOSED') then raise exception 'TABLE_CAPACITY_INSUFFICIENT'; end if;
  waiter:=private.responsible_waiter(p_from);
  update public.accounts set table_id=p_to where table_id=p_from and status<>'CLOSED';
  update private.customer_sessions set table_id=p_to where table_id=p_from and revoked_at is null and account_id in(select id from public.accounts where table_id=p_to and status<>'CLOSED');
  update public.waiter_calls set table_id=p_to where table_id=p_from and status<>'COMPLETED';
  update public.reservations set table_id=p_to where table_id=p_from and status in ('ARRIVED','SEATED');
  if waiter is not null then
    update public.table_assignments set active=false where table_id=p_to and active;
    insert into public.table_assignments(venue_id,waiter_id,mode,table_id) values(old_table.venue_id,waiter,'TABLE',p_to);
  end if;
  update public.tables set technical_status=old_table.technical_status where id=p_to;
  update public.tables set technical_status='TO_RESET' where id=p_from;
  perform private.audit('TABLE_MOVED','tables',p_to,old_table.venue_id,jsonb_build_object('table_id',p_from),jsonb_build_object('table_id',p_to));
end $$;
create function public.merge_tables(p_primary uuid,p_secondary uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare first_table public.tables; second_table public.tables; ref uuid;
begin
  perform 1 from public.tables where id in (p_primary,p_secondary) order by id for update;
  select * into first_table from public.tables where id=p_primary and active;
  select * into second_table from public.tables where id=p_secondary and active;
  if first_table.id is null or second_table.id is null or first_table.id=second_table.id or first_table.venue_id<>second_table.venue_id then raise exception 'TABLE_FORBIDDEN'; end if;
  perform private.authorize(first_table.venue_id,array['ADMIN','HOST']::public.user_role[]);
  if exists(select 1 from public.table_merges where split_at is null and (secondary_table_id in (p_primary,p_secondary) or primary_table_id=p_secondary)) then raise exception 'TABLE_ALREADY_MERGED'; end if;
  insert into public.table_merges(venue_id,primary_table_id,secondary_table_id) values(first_table.venue_id,p_primary,p_secondary) returning id into ref;
  return ref;
end $$;
create function public.split_tables(p_primary uuid) returns void language plpgsql security definer set search_path='' as $$
declare venue uuid;
begin
  select venue_id into venue from public.tables where id=p_primary for update;
  if venue is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(venue,array['ADMIN','HOST']::public.user_role[]);
  if exists(select 1 from public.accounts where status<>'CLOSED' and (table_id=p_primary or table_id in(select secondary_table_id from public.table_merges where primary_table_id=p_primary and split_at is null))) then raise exception 'TABLE_GROUP_IN_SERVICE'; end if;
  update public.table_merges set split_at=now() where primary_table_id=p_primary and split_at is null;
end $$;
grant execute on function public.transition_reservation(uuid,public.reservation_status,bigint),public.assign_table(uuid,uuid,boolean),public.create_walk_in(uuid,uuid,integer,text,uuid),
  public.suggest_tables(uuid),public.set_table_available(uuid),public.move_table(uuid,uuid,boolean),public.merge_tables(uuid,uuid),public.split_tables(uuid) to authenticated;
commit;
