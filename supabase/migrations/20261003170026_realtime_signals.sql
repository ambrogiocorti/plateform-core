begin;
-- Only invalidation signals enter Realtime. Business rows, secrets and PII are never published.
create table public.realtime_signals (
  id uuid primary key default gen_random_uuid(), venue_id uuid references public.venues(id),
  topic text not null check(topic in ('PUBLIC','FLOOR','BOOKING','ACCOUNT','KITCHEN','FINANCE','CALL','NOTIFICATION','ACCESS','CONFIG')),
  resource_id uuid, account_id uuid, recipient_user_id uuid, created_at timestamptz not null default now()
);
create index realtime_signals_venue on public.realtime_signals(venue_id,created_at);
create index realtime_signals_recipient on public.realtime_signals(recipient_user_id,created_at) where recipient_user_id is not null;
alter table public.realtime_signals enable row level security;
revoke all on public.realtime_signals from public,anon,authenticated;
grant select on public.realtime_signals to anon,authenticated;

create function private.can_read_signal(p_signal public.realtime_signals) returns boolean language plpgsql stable security definer set search_path='' as $$
declare role_name public.user_role:=private.current_role();
begin
  if p_signal.topic='PUBLIC' then return exists(select 1 from public.venues where id=p_signal.venue_id and active); end if;
  -- This contains no permission or business data and remains visible to its JWT owner after revocation.
  if p_signal.topic='ACCESS' then return auth.uid() is not null and auth.uid()=p_signal.recipient_user_id; end if;
  if p_signal.topic='ACCOUNT' and private.owns_customer_account(p_signal.account_id) then return true; end if;
  if not coalesce(private.has_venue(p_signal.venue_id),false) then return false; end if;
  case p_signal.topic
    when 'FLOOR' then return role_name in ('ADMIN','HOST','WAITER','CASHIER','PASS');
    when 'BOOKING' then return role_name in ('ADMIN','HOST');
    when 'ACCOUNT' then return private.can_read_account(p_signal.account_id);
    when 'FINANCE' then return role_name in ('ADMIN','CASHIER');
    when 'CONFIG' then return role_name='ADMIN';
    when 'CALL' then return exists(select 1 from public.waiter_calls where id=p_signal.resource_id and (role_name='ADMIN' or assigned_waiter_id=private.effective_user_id()));
    when 'NOTIFICATION' then return exists(select 1 from public.notifications where id=p_signal.resource_id and (recipient_user_id=private.effective_user_id() or (recipient_user_id is null and recipient_role=role_name)));
    when 'KITCHEN' then
      return role_name in ('ADMIN','KITCHEN_ADMIN','PASS') or
        (role_name='WAITER' and (private.can_read_account(p_signal.account_id) or exists(select 1 from public.table_assignments where venue_id=p_signal.venue_id and waiter_id=private.effective_user_id() and active and mode='RUNNER')))
        or (role_name='KITCHEN_STAFF' and exists(select 1 from public.order_items i join public.station_staff_assignments s on s.venue_id=i.venue_id and s.user_id=private.effective_user_id() and s.active
          where i.order_id=p_signal.resource_id and (s.station_id=i.station_id or exists(select 1 from public.dish_station_assignments d where d.venue_id=i.venue_id and d.dish_id=i.dish_id and d.station_id=s.station_id))));
    else return false;
  end case;
end $$;
grant usage on schema private to anon;
grant execute on function private.can_read_signal(public.realtime_signals) to anon,authenticated;
create policy visible_signal on public.realtime_signals for select to authenticated using(private.can_read_signal(realtime_signals));
create policy public_signal on public.realtime_signals for select to anon using(topic='PUBLIC' and private.can_read_signal(realtime_signals));

create function private.emit_signal(p_topic text,p_venue uuid,p_resource uuid default null,p_account uuid default null,p_user uuid default null) returns void language sql volatile security definer set search_path='' as $$
  insert into public.realtime_signals(topic,venue_id,resource_id,account_id,recipient_user_id) values(p_topic,p_venue,p_resource,p_account,p_user)
$$;

create function private.signal_change() returns trigger language plpgsql security definer set search_path='' as $$
declare data jsonb:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  venue uuid; resource uuid; account uuid; order_ref uuid; subject uuid; v record;
begin
  venue:=(data->>'venue_id')::uuid;
  if data->>'id' ~ '^[0-9a-f-]{36}$' then resource:=(data->>'id')::uuid; end if;
  case
    when tg_table_name in ('staff_sessions','customer_sessions','staff_profiles','staff_venue_assignments','registered_devices','station_staff_assignments','cashier_assignments') then
      subject:=coalesce((data->>'user_id')::uuid,(data->>'auth_user_id')::uuid,case when tg_table_name='staff_profiles' then resource end);
      perform private.emit_signal('ACCESS',venue,null,null,subject);
    when tg_table_name in ('restaurant_profile','restaurant_settings','feature_flags','venues','venue_settings') then
      if tg_table_name='venues' then venue:=resource; end if;
      for v in select id from public.venues where venue is null or id=venue loop perform private.emit_signal('PUBLIC',v.id); end loop;
      for v in select id from public.staff_profiles loop perform private.emit_signal('ACCESS',venue,null,null,v.id); end loop;
      for v in select distinct auth_user_id from private.customer_sessions where revoked_at is null loop perform private.emit_signal('ACCESS',venue,null,null,v.auth_user_id); end loop;
    when tg_table_name in ('categories','dishes','ingredients','allergens','ingredient_allergens','dish_ingredients','dietary_tags','dish_dietary_tags','variant_groups','variant_options','venue_dish_settings') then
      for v in select id from public.venues where venue is null or id=venue loop perform private.emit_signal('PUBLIC',v.id); end loop;
    when tg_table_name in ('tables','rooms','room_layouts','zones','table_merges','table_assignments','table_status_definitions') then
      perform private.emit_signal('FLOOR',venue,resource);
      if tg_table_name='table_assignments' then perform private.emit_signal('ACCESS',venue,null,null,(data->>'waiter_id')::uuid); end if;
    when tg_table_name in ('reservations','services','service_booking_rules','booking_time_slots','reservation_answers') then perform private.emit_signal('BOOKING',venue,resource);
    when tg_table_name='accounts' then perform private.emit_signal('ACCOUNT',venue,resource,resource);
    when tg_table_name in ('orders','order_steps','order_items','order_change_requests','step_deliveries') then
      order_ref:=case when tg_table_name='orders' then resource when tg_table_name='step_deliveries' then (select order_id from public.order_steps where id=(data->>'step_id')::uuid) else (data->>'order_id')::uuid end;
      select account_id into account from public.orders where id=order_ref;
      perform private.emit_signal('ACCOUNT',venue,order_ref,account);
      perform private.emit_signal('KITCHEN',venue,order_ref,account);
    when tg_table_name='customer_order_requests' then perform private.emit_signal('ACCOUNT',venue,resource,(data->>'account_id')::uuid);
    when tg_table_name in ('payments','refunds','discounts') then
      account:=(data->>'account_id')::uuid;
      if tg_table_name='refunds' then select account_id into account from public.payments where id=(data->>'original_payment_id')::uuid; end if;
      perform private.emit_signal('ACCOUNT',venue,null,account); perform private.emit_signal('FINANCE',venue,resource);
    when tg_table_name in ('cash_registers','cash_register_sessions','service_sessions','cash_reconciliations','print_jobs') then perform private.emit_signal('FINANCE',venue,resource);
    when tg_table_name='waiter_calls' then perform private.emit_signal('CALL',venue,resource);
    when tg_table_name='notifications' then perform private.emit_signal('NOTIFICATION',venue,resource);
    else perform private.emit_signal('CONFIG',venue,resource);
  end case;
  return coalesce(new,old);
end $$;

do $$ declare entity text;
begin
  foreach entity in array array['restaurant_profile','restaurant_settings','feature_flags','venues','venue_settings','staff_profiles','staff_venue_assignments','registered_devices','station_staff_assignments','cashier_assignments',
    'categories','dishes','ingredients','allergens','ingredient_allergens','dish_ingredients','dietary_tags','dish_dietary_tags','variant_groups','variant_options','venue_dish_settings',
    'tables','rooms','room_layouts','zones','table_merges','table_assignments','table_status_definitions','reservations','services','service_booking_rules','booking_time_slots','reservation_answers',
    'accounts','orders','order_steps','order_items','order_change_requests','step_deliveries','customer_order_requests','payments','refunds','discounts','cash_registers','cash_register_sessions','service_sessions','cash_reconciliations','print_jobs','waiter_calls','notifications'] loop
    execute format('create trigger realtime_invalidation after insert or update or delete on public.%I for each row execute function private.signal_change()',entity);
  end loop;
  create trigger realtime_access after insert or update or delete on private.staff_sessions for each row execute function private.signal_change();
  create trigger realtime_access after insert or update or delete on private.customer_sessions for each row execute function private.signal_change();
  if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and (schemaname,tablename)<>('public','realtime_signals')) then raise exception 'REALTIME_PUBLICATION_HAS_UNREVIEWED_TABLES'; end if;
  if not exists(select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime with (publish='insert');
  else alter publication supabase_realtime set (publish='insert'); end if;
  alter publication supabase_realtime add table public.realtime_signals;
end $$;

create function public.purge_realtime_signals() returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin delete from public.realtime_signals where created_at<now()-interval '1 day'; get diagnostics removed=row_count; return removed; end $$;
grant execute on function public.purge_realtime_signals() to service_role;
commit;
