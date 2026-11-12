
create index if not exists billing_units_venue_account_fk_idx
  on public.billing_units(venue_id,account_id);

create index if not exists billing_units_venue_item_fk_idx
  on public.billing_units(venue_id,order_item_id);

create index if not exists cash_register_sessions_venue_register_fk_idx
  on public.cash_register_sessions(venue_id,cash_register_id);

create index if not exists cash_register_sessions_venue_service_fk_idx
  on public.cash_register_sessions(venue_id,service_session_id);

create index if not exists cashier_assignments_venue_register_fk_idx
  on public.cashier_assignments(venue_id,cash_register_id);

create index if not exists dish_station_assignments_dish_fk_idx
  on public.dish_station_assignments(dish_id);

create index if not exists dish_station_assignments_venue_station_fk_idx
  on public.dish_station_assignments(venue_id,station_id);

create index if not exists service_sessions_opened_by_fk_idx
  on public.service_sessions(opened_by);

create index if not exists service_sessions_venue_service_fk_idx
  on public.service_sessions(venue_id,service_id);

create index if not exists station_staff_assignments_venue_station_fk_idx
  on public.station_staff_assignments(venue_id,station_id);

create index if not exists table_assignments_venue_table_fk_idx
  on public.table_assignments(venue_id,table_id);

create index if not exists table_assignments_venue_zone_fk_idx
  on public.table_assignments(venue_id,zone_id);

create index if not exists table_merges_venue_primary_fk_idx
  on public.table_merges(venue_id,primary_table_id);

create index if not exists table_merges_venue_secondary_fk_idx
  on public.table_merges(venue_id,secondary_table_id);

create index if not exists venue_dish_settings_venue_station_fk_idx
  on public.venue_dish_settings(venue_id,local_station_id);

create index if not exists order_item_removed_venue_item_fk_idx
  on public.order_item_removed_ingredients(venue_id,order_item_id);

create index if not exists order_item_removed_ingredient_fk_idx
  on public.order_item_removed_ingredients(ingredient_id);

create index if not exists order_item_variants_venue_item_fk_idx
  on public.order_item_variants(venue_id,order_item_id);

create index if not exists order_item_variants_option_fk_idx
  on public.order_item_variants(option_id);

create index if not exists tips_venue_payment_fk_idx
  on public.tips(venue_id,payment_id);
