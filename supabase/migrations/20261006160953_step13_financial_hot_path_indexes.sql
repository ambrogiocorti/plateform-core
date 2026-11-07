
create index if not exists order_items_venue_order_step_idx
  on public.order_items(venue_id,order_id,step_id);

create index if not exists order_items_venue_step_idx
  on public.order_items(venue_id,step_id);

create index if not exists payment_allocations_venue_payment_item_idx
  on public.payment_allocations(venue_id,payment_id,order_item_id);

create index if not exists payment_allocations_venue_item_idx
  on public.payment_allocations(venue_id,order_item_id);

create index if not exists payment_unit_allocations_venue_payment_unit_idx
  on public.payment_unit_allocations(venue_id,payment_id,billing_unit_id);

create index if not exists payment_unit_allocations_venue_unit_idx
  on public.payment_unit_allocations(venue_id,billing_unit_id);

create index if not exists refunds_venue_original_payment_idx
  on public.refunds(venue_id,original_payment_id);

create index if not exists cash_journal_venue_payment_idx
  on public.cash_journal(venue_id,payment_id);
