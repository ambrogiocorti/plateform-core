begin;
-- An already released table with unfinished historical work needs an explicit operator decision.
do $$ begin
  if exists(select 1 from public.accounts a join public.orders o on o.account_id=a.id join public.order_items i on i.order_id=o.id
    where a.floor_released_at is not null and i.status not in ('SERVED','CANCELLED')) then raise exception 'MIGRATION_FULFILLMENT_RECONCILIATION_REQUIRED'; end if;
end $$;

create or replace function private.guard_account_floor_release() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and old.floor_released_at is not null and new.floor_released_at is distinct from old.floor_released_at then raise exception 'ACCOUNT_FLOOR_ALREADY_RELEASED'; end if;
  if new.status='CLOSED' and new.floor_released_at is null and not exists(select 1 from public.orders o join public.order_items i on i.order_id=o.id where o.account_id=new.id and i.status not in ('SERVED','CANCELLED')) then new.floor_released_at:=now(); end if;
  return new;
end $$;

create or replace function private.release_account_floor(p_account uuid,p_table uuid) returns void language plpgsql security definer set search_path='' as $$
declare members uuid[]:=private.table_group(p_table);
begin
  if not exists(select 1 from public.accounts where table_id=any(members) and floor_released_at is null) then
    update public.tables set technical_status='TO_RESET' where id=any(members);
  end if;
end $$;

create function private.release_fulfilled_account() returns trigger language plpgsql security definer set search_path='' as $$
declare account public.accounts;
begin
  if new.status not in ('SERVED','CANCELLED') then return new; end if;
  select a.* into account from public.accounts a join public.orders o on o.account_id=a.id where o.id=new.order_id;
  if account.status<>'CLOSED' or account.floor_released_at is not null then return new; end if;
  perform private.lock_floor(account.venue_id);
  select * into account from public.accounts where id=account.id for update;
  if account.status='CLOSED' and account.floor_released_at is null and not exists(select 1 from public.orders o join public.order_items i on i.order_id=o.id where o.account_id=account.id and i.status not in ('SERVED','CANCELLED')) then
    update public.accounts set floor_released_at=now() where id=account.id;
    perform private.release_account_floor(account.id,account.table_id);
  end if;
  return new;
end $$;
create trigger release_fulfilled_account after update of status on public.order_items for each row execute function private.release_fulfilled_account();


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
    or exists(select 1 from public.accounts where table_id=any(members) and floor_released_at is null) then raise exception 'TABLE_NOT_AVAILABLE'; end if;
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
  if p_status='COMPLETED' and exists(select 1 from public.accounts where table_id=any(members) and floor_released_at is null) then raise exception 'TABLE_HAS_OPEN_ACCOUNTS'; end if;
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
  if exists(select 1 from public.accounts where table_id=any(members) and floor_released_at is null) or exists(select 1 from public.reservations where table_id=any(members) and status in ('ARRIVED','SEATED')) then raise exception 'TABLE_STILL_IN_USE'; end if;
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
  if exists(select 1 from public.accounts where floor_released_at is null and table_id=any(members))
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
    or exists(select 1 from public.accounts where table_id=any(target_members) and floor_released_at is null)
    or exists(select 1 from public.reservations where table_id=any(target_members) and status in ('REQUESTED','RESERVED','ARRIVED','SEATED')) then raise exception 'TARGET_TABLE_NOT_AVAILABLE'; end if;
  perform 1 from public.accounts where table_id=any(source_members||target_members) order by id for update;
  -- A seated reservation and its account describe the same guests; do not double-count them.
  select greatest(coalesce((select sum(covers) from public.accounts where table_id=any(source_members) and floor_released_at is null),0),
    coalesce((select sum(party_size) from public.reservations where table_id=any(source_members) and status in ('ARRIVED','SEATED')),0)) into required_seats;
  if required_seats=0 then raise exception 'SOURCE_TABLE_EMPTY'; end if;
  if (select sum(seats) from public.tables where id=any(target_members))<required_seats then raise exception 'TABLE_CAPACITY_INSUFFICIENT'; end if;
  waiter:=private.responsible_waiter(p_from);
  update public.accounts set table_id=p_to where table_id=any(source_members) and floor_released_at is null;
  update private.customer_sessions set table_id=p_to where table_id=any(source_members) and revoked_at is null and account_id in(select id from public.accounts where table_id=p_to and floor_released_at is null);
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

create or replace function public.suggest_tables(p_reservation uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.reservations; result jsonb;
begin
  select * into r from public.reservations where id=p_reservation;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(r.venue_id,array['ADMIN','HOST']::public.user_role[],false);
  with recursive available as (
    select t.* from public.tables t join public.room_layouts l on l.id=t.layout_id and l.active and not l.archived
    where t.venue_id=r.venue_id and t.active and t.technical_status='AVAILABLE'
      and not exists(select 1 from public.accounts a where a.table_id=t.id and a.floor_released_at is null)
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
  if exists(select 1 from public.reservations where table_id=p_secondary and status in ('REQUESTED','RESERVED','ARRIVED','SEATED')) or exists(select 1 from public.accounts where table_id=p_secondary and floor_released_at is null) then raise exception 'TABLE_STILL_IN_USE'; end if;
  insert into public.table_merges(venue_id,primary_table_id,secondary_table_id) values(first_table.venue_id,p_primary,p_secondary) returning id into ref;
  update public.tables set technical_status=first_table.technical_status where id=p_secondary;
  return ref;
end $$;

create or replace function public.get_kitchen_board(p_venue uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.authorize(p_venue,array['ADMIN','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[],false);
  return coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'order_id',o.id,'step_id',s.id,'step_number',s.step_number,'step_status',s.status,
    'table_name',t.name,'table_number',t.number,'dish_name',i.dish_name,'quantity',i.quantity,'status',i.status,'station_id',i.station_id,'version',i.version,
    'created_at',o.created_at,'started_at',i.started_at,'can_prepare',private.can_work_station(p_venue,i.station_id),
    'can_deliver',private.current_role()='WAITER' and (private.responsible_waiter(t.id)=private.effective_user_id() or exists(select 1 from public.table_assignments a where a.venue_id=p_venue and a.waiter_id=private.effective_user_id() and a.mode='RUNNER' and a.active)),
    'removed_ingredients',coalesce((select jsonb_agg(ingredient_name) from public.order_item_removed_ingredients where order_item_id=i.id),'[]'),
    'variants',coalesce((select jsonb_agg(jsonb_build_object('group',group_name,'option',option_name)) from public.order_item_variants where order_item_id=i.id),'[]')) order by o.created_at,s.step_number,i.dish_name)
    from public.order_items i join public.orders o on o.id=i.order_id join public.order_steps s on s.id=i.step_id
    join public.accounts a on a.id=o.account_id join public.tables t on t.id=a.table_id
    where i.venue_id=p_venue and i.status not in ('SERVED','CANCELLED') and a.floor_released_at is null
      and (private.is_role(array['ADMIN','KITCHEN_ADMIN','PASS']::public.user_role[])
        or (private.current_role()='WAITER' and (private.responsible_waiter(t.id)=private.effective_user_id() or
          (s.status='READY' and exists(select 1 from public.table_assignments ta where ta.venue_id=p_venue and ta.waiter_id=private.effective_user_id() and ta.mode='RUNNER' and ta.active))))
        or (private.current_role()='KITCHEN_STAFF' and exists(select 1 from public.station_staff_assignments sa
          where sa.user_id=private.effective_user_id() and sa.venue_id=p_venue and sa.active and
          (sa.station_id=i.station_id or exists(select 1 from public.dish_station_assignments da where da.venue_id=p_venue and da.dish_id=i.dish_id and da.station_id=sa.station_id)))))),'[]');
end $$;

create or replace function public.deliver_step(p_step uuid,p_served boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare step public.order_steps; table_ref uuid; assigned uuid;
begin
  perform private.lock_floor((select venue_id from public.order_steps where id=p_step));
  select * into step from public.order_steps where id=p_step;
  if step.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(step.venue_id,array['WAITER']::public.user_role[]);
  select a.table_id into table_ref from public.accounts a join public.orders o on o.account_id=a.id where o.id=step.order_id;
  if private.responsible_waiter(table_ref) is distinct from private.effective_user_id() and not exists(select 1 from public.table_assignments where venue_id=step.venue_id and waiter_id=private.effective_user_id() and mode='RUNNER' and active) then raise exception 'DELIVERY_FORBIDDEN'; end if;
  perform 1 from public.orders where id=step.order_id for update;
  select * into step from public.order_steps where id=p_step for update;
  if step.status<>'READY' then raise exception 'STEP_NOT_READY'; end if;
  insert into public.step_deliveries(step_id,venue_id,waiter_id) values(step.id,step.venue_id,private.effective_user_id()) on conflict(step_id) do nothing;
  select waiter_id into assigned from public.step_deliveries where step_id=step.id;
  if assigned<>private.effective_user_id() then raise exception 'DELIVERY_ALREADY_CLAIMED'; end if;
  if p_served then
    update public.step_deliveries set served_at=now() where step_id=step.id;
    update public.order_steps set status='SERVED',served_at=now() where id=step.id;
    update public.order_items set status='SERVED',served_at=now() where step_id=step.id and status='READY';
    perform private.refresh_order_status(step.order_id);
  end if;
end $$;

create or replace function public.get_account_workspace(p_account uuid,p_before_at timestamptz default null,p_before_id uuid default null,p_limit integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare account public.accounts;
begin
  if not private.can_read_account(p_account) then raise exception 'FORBIDDEN'; end if;
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null)<>(p_before_id is null) then raise exception 'INVALID_FILTER'; end if;
  select * into account from public.accounts where id=p_account;
  return (with page as (
    select o.id,o.created_at,o.status from public.orders o where o.account_id=account.id
    and (p_before_at is null or (o.created_at,o.id)<(p_before_at,p_before_id)) order by o.created_at desc,o.id desc limit p_limit+1
  ) select jsonb_build_object('account',jsonb_build_object('id',account.id,'venue_id',account.venue_id,'account_name',account.account_name,'table_id',account.table_id,
      'table_name',(select name from public.tables where id=account.table_id),'covers',account.covers,'status',account.status,'version',account.version,'floor_released_at',account.floor_released_at,
      'unserved_items',(select count(*) from public.orders o join public.order_items i on i.order_id=o.id where o.account_id=account.id and i.status not in ('SERVED','CANCELLED'))),
    'balance',private.account_balance(account.id),'orders',coalesce((select jsonb_agg(to_jsonb(item)||jsonb_build_object('items',
       coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'dish_name',i.dish_name,'quantity',i.quantity,'unit_price_cents',i.unit_price_cents,'status',i.status) order by i.id) from public.order_items i where i.order_id=item.id),'[]')) order by item.created_at desc,item.id desc)
      from (select * from page order by created_at desc,id desc limit p_limit) item),'[]'),'has_more',(select count(*)>p_limit from page)));
end $$;
commit;
