
create index if not exists accounts_venue_table_fk_idx
  on public.accounts(venue_id,table_id);

create index if not exists orders_venue_account_fk_idx
  on public.orders(venue_id,account_id);

create index if not exists order_items_dish_fk_idx
  on public.order_items(dish_id);

create index if not exists payments_venue_account_fk_idx
  on public.payments(venue_id,account_id);

create index if not exists payments_venue_register_fk_idx
  on public.payments(venue_id,cash_register_id);

create index if not exists payments_venue_service_fk_idx
  on public.payments(venue_id,service_session_id);

create index if not exists reservations_venue_table_fk_idx
  on public.reservations(venue_id,table_id);

create index if not exists waiter_calls_venue_account_fk_idx
  on public.waiter_calls(venue_id,account_id);

create index if not exists waiter_calls_venue_table_fk_idx
  on public.waiter_calls(venue_id,table_id);

create index if not exists notifications_venue_fk_idx
  on public.notifications(venue_id);

create index if not exists provider_operations_venue_fk_idx
  on public.provider_operations(venue_id);
