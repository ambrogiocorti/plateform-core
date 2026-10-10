
create index if not exists customer_sessions_table_id_idx
  on private.customer_sessions(table_id);

create index if not exists provider_operation_events_operation_id_idx
  on private.provider_operation_events(operation_id);

create index if not exists step_up_grants_user_id_idx
  on private.step_up_grants(user_id);

create index if not exists venue_dish_settings_dish_id_idx
  on public.venue_dish_settings(dish_id);

create index if not exists waiter_calls_assigned_waiter_id_idx
  on public.waiter_calls(assigned_waiter_id);

create index if not exists tables_venue_zone_idx
  on public.tables(venue_id,zone_id);

create index if not exists tables_venue_room_layout_idx
  on public.tables(venue_id,room_id,layout_id);
