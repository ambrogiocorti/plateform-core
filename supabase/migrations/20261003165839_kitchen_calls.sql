begin;
create function public.get_kitchen_board(p_venue uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
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
    where i.venue_id=p_venue and i.status not in ('SERVED','CANCELLED') and a.status<>'CLOSED'
      and (private.is_role(array['ADMIN','KITCHEN_ADMIN','PASS']::public.user_role[])
        or (private.current_role()='WAITER' and (private.responsible_waiter(t.id)=private.effective_user_id() or
          (s.status='READY' and exists(select 1 from public.table_assignments ta where ta.venue_id=p_venue and ta.waiter_id=private.effective_user_id() and ta.mode='RUNNER' and ta.active))))
        or (private.current_role()='KITCHEN_STAFF' and exists(select 1 from public.station_staff_assignments sa
          where sa.user_id=private.effective_user_id() and sa.venue_id=p_venue and sa.active and
          (sa.station_id=i.station_id or exists(select 1 from public.dish_station_assignments da where da.venue_id=p_venue and da.dish_id=i.dish_id and da.station_id=sa.station_id)))))),'[]');
end $$;

create function private.refresh_order_status(p_order uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  update public.orders set status=case
    when not exists(select 1 from public.order_items where order_id=p_order and status<>'CANCELLED') then 'CANCELLED'::public.order_status
    when not exists(select 1 from public.order_items where order_id=p_order and status not in ('SERVED','CANCELLED')) then 'SERVED'::public.order_status
    when not exists(select 1 from public.order_items where order_id=p_order and status not in ('READY','SERVED','CANCELLED')) then 'READY'::public.order_status
    when exists(select 1 from public.order_items where order_id=p_order and status in ('IN_PREPARATION','READY','SERVED')) then 'IN_PREPARATION'::public.order_status
    else 'RECEIVED'::public.order_status end where id=p_order;
end $$;
create function public.transition_order_item(p_item uuid,p_status public.order_status,p_version bigint) returns void language plpgsql security definer set search_path='' as $$
declare item public.order_items; step public.order_steps;
begin
  select * into item from public.order_items where id=p_item;
  if item.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(item.venue_id,array['KITCHEN_ADMIN','KITCHEN_STAFF']::public.user_role[]);
  if not private.can_work_station(item.venue_id,item.station_id) then raise exception 'PRIMARY_STATION_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.orders where id=item.order_id for update;
  select * into step from public.order_steps where id=item.step_id for update;
  select * into item from public.order_items where id=p_item for update;
  if item.version is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if step.status<>'ACTIVE' then raise exception 'STEP_NOT_ACTIVE'; end if;
  if not ((item.status='RECEIVED' and p_status='IN_PREPARATION') or (item.status='IN_PREPARATION' and p_status='READY')) then raise exception 'INVALID_TRANSITION'; end if;
  update public.order_items set status=p_status,started_at=case when p_status='IN_PREPARATION' then now() else started_at end,ready_at=case when p_status='READY' then now() else ready_at end where id=item.id;
  if p_status='READY' and not exists(select 1 from public.order_items where step_id=step.id and status not in ('READY','SERVED','CANCELLED')) then
    insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id) values(item.venue_id,'PASS','STEP_PREPARED','Piatti dello step pronti','order_steps',step.id);
  end if;
  perform private.refresh_order_status(item.order_id);
end $$;
create function public.start_order_step(p_step uuid) returns void language plpgsql security definer set search_path='' as $$
declare step public.order_steps; a public.accounts;
begin
  select * into step from public.order_steps where id=p_step;
  if step.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(step.venue_id,array['WAITER','PASS','KITCHEN_ADMIN']::public.user_role[]);
  if not exists(select 1 from public.venue_settings where venue_id=step.venue_id and private.current_role()=any(step_starter_roles)) then raise exception 'STEP_ROLE_FORBIDDEN'; end if;
  select a0.* into a from public.accounts a0 join public.orders o on o.account_id=a0.id where o.id=step.order_id;
  if private.current_role()='WAITER' and private.responsible_waiter(a.table_id) is distinct from private.effective_user_id() then raise exception 'RESPONSIBLE_WAITER_REQUIRED'; end if;
  perform 1 from public.orders where id=step.order_id for update;
  select * into step from public.order_steps where id=p_step for update;
  if step.status='ACTIVE' then return; end if;
  if step.status<>'WAITING' or exists(select 1 from public.order_steps where order_id=step.order_id and step_number<step.step_number and status not in ('SERVED','CANCELLED')) then raise exception 'PREVIOUS_STEP_NOT_SERVED'; end if;
  update public.order_steps set status='ACTIVE',started_at=now() where id=step.id;
end $$;
create function public.mark_step_ready(p_step uuid) returns void language plpgsql security definer set search_path='' as $$
declare step public.order_steps; table_ref uuid; waiter uuid; routes text[];
begin
  select * into step from public.order_steps where id=p_step;
  if step.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(step.venue_id,array['PASS']::public.user_role[]);
  perform 1 from public.orders where id=step.order_id for update;
  select * into step from public.order_steps where id=p_step for update;
  if step.status='READY' then return; end if;
  if step.status<>'ACTIVE' or exists(select 1 from public.order_items where step_id=step.id and status not in ('READY','CANCELLED')) then raise exception 'STEP_NOT_PREPARED'; end if;
  update public.order_steps set status='READY',ready_at=now() where id=step.id;
  select a.table_id into table_ref from public.accounts a join public.orders o on o.account_id=a.id where o.id=step.order_id;
  waiter:=private.responsible_waiter(table_ref);
  select delivery_routing into routes from public.venue_settings where venue_id=step.venue_id;
  if routes && array['TABLE','ZONE'] and waiter is not null then
    insert into public.notifications(venue_id,recipient_user_id,category,title,resource_type,resource_id) values(step.venue_id,waiter,'STEP_READY','Step pronto per il servizio','order_steps',step.id);
  end if;
  if 'RUNNER'=any(routes) then
    insert into public.notifications(venue_id,recipient_user_id,category,title,resource_type,resource_id)
      select step.venue_id,waiter_id,'STEP_READY','Consegna pronta al Pass','order_steps',step.id from public.table_assignments where venue_id=step.venue_id and mode='RUNNER' and active;
  end if;
end $$;
create table public.step_deliveries (
  step_id uuid primary key references public.order_steps(id), venue_id uuid not null references public.venues(id),
  waiter_id uuid not null references public.staff_profiles(id), claimed_at timestamptz not null default now(), served_at timestamptz
);
alter table public.step_deliveries enable row level security;
revoke all on public.step_deliveries from anon,authenticated;
grant select on public.step_deliveries to authenticated;
create policy deliveries_read on public.step_deliveries for select to authenticated using(private.has_venue(venue_id) and (waiter_id=private.effective_user_id() or private.is_role(array['ADMIN','PASS']::public.user_role[])));
create trigger audit_mutation after insert or update or delete on public.step_deliveries for each row execute function private.audit_row();

create function public.deliver_step(p_step uuid,p_served boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare step public.order_steps; table_ref uuid; assigned uuid;
begin
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

create function public.call_waiter(p_account uuid,p_kind text default 'WAITER') returns uuid language plpgsql security definer set search_path='' as $$
declare a public.accounts; assigned uuid; ref uuid;
begin
  if not private.owns_customer_account(p_account) then raise exception 'CUSTOMER_SESSION_REQUIRED' using errcode='42501'; end if;
  select * into a from public.accounts where id=p_account for update;
  if p_kind not in ('WAITER','BILL') then raise exception 'INVALID_CALL'; end if;
  if p_kind='BILL' and not exists(select 1 from public.venue_settings where venue_id=a.venue_id and customer_bill_request) then raise exception 'BILL_REQUEST_DISABLED'; end if;
  select id into ref from public.waiter_calls where account_id=a.id and kind=p_kind and status<>'COMPLETED';
  if ref is not null then return ref; end if;
  assigned:=private.responsible_waiter(a.table_id);
  insert into public.waiter_calls(venue_id,account_id,table_id,assigned_waiter_id,kind) values(a.venue_id,a.id,a.table_id,assigned,p_kind) returning id into ref;
  insert into public.notifications(venue_id,recipient_user_id,recipient_role,category,title,resource_type,resource_id)
    values(a.venue_id,assigned,case when assigned is null then 'ADMIN'::public.user_role end,'CUSTOMER_CALL',
      case when assigned is null then 'Tavolo senza cameriere responsabile' when p_kind='BILL' then 'Richiesta conto' else 'Chiamata dal tavolo' end,'waiter_calls',ref);
  if p_kind='BILL' then
    update public.accounts set status='BILL_REQUESTED' where id=a.id and status='OPEN';
    insert into public.notifications(venue_id,recipient_role,category,title,resource_type,resource_id) values(a.venue_id,'CASHIER','BILL_REQUEST','Richiesta conto','accounts',a.id);
  end if;
  return ref;
end $$;
create function public.transition_waiter_call(p_call uuid,p_complete boolean) returns void language plpgsql security definer set search_path='' as $$
declare c public.waiter_calls;
begin
  select * into c from public.waiter_calls where id=p_call for update;
  if c.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(c.venue_id,array['WAITER']::public.user_role[]);
  if c.assigned_waiter_id is distinct from private.effective_user_id() then raise exception 'CALL_NOT_ASSIGNED'; end if;
  if (p_complete and c.status<>'ACCEPTED') or (not p_complete and c.status<>'NEW') then raise exception 'INVALID_TRANSITION'; end if;
  update public.waiter_calls set status=case when p_complete then 'COMPLETED' else 'ACCEPTED' end,
    accepted_at=case when not p_complete then now() else accepted_at end,completed_at=case when p_complete then now() end where id=c.id;
end $$;
create function public.transition_notification(p_notification uuid,p_status public.notification_status) returns void language plpgsql security definer set search_path='' as $$
declare n public.notifications;
begin
  select * into n from public.notifications where id=p_notification for update;
  if n.id is null then raise exception 'NOT_FOUND'; end if;
  perform private.authorize(n.venue_id,array['ADMIN','HOST','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER']::public.user_role[]);
  if n.recipient_user_id is not null and n.recipient_user_id<>private.effective_user_id() or n.recipient_user_id is null and n.recipient_role<>private.current_role() then raise exception 'NOTIFICATION_FORBIDDEN'; end if;
  if not ((n.status='NEW' and p_status='ACKNOWLEDGED') or (n.status='ACKNOWLEDGED' and p_status='RESOLVED')) then raise exception 'INVALID_TRANSITION'; end if;
  update public.notifications set status=p_status,acknowledged_at=case when p_status='ACKNOWLEDGED' then now() else acknowledged_at end,resolved_at=case when p_status='RESOLVED' then now() end where id=n.id;
end $$;
grant execute on function public.get_kitchen_board(uuid),public.transition_order_item(uuid,public.order_status,bigint),public.start_order_step(uuid),public.mark_step_ready(uuid),public.deliver_step(uuid,boolean),
  public.call_waiter(uuid,text),public.transition_waiter_call(uuid,boolean),public.transition_notification(uuid,public.notification_status) to authenticated;
commit;
