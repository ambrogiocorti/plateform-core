
create index if not exists accounts_created_by_fk_idx
  on public.accounts(created_by);

create index if not exists orders_created_by_fk_idx
  on public.orders(created_by);

create index if not exists payments_operator_fk_idx
  on public.payments(operator_user_id);

create index if not exists cash_journal_operator_fk_idx
  on public.cash_journal(operator_user_id);

create index if not exists cash_journal_venue_account_fk_idx
  on public.cash_journal(venue_id,account_id);

create index if not exists cash_journal_venue_register_fk_idx
  on public.cash_journal(venue_id,cash_register_id);

create index if not exists cash_journal_venue_service_fk_idx
  on public.cash_journal(venue_id,service_session_id);

create index if not exists print_jobs_lease_owner_fk_idx
  on public.print_jobs(lease_owner);

create index if not exists print_jobs_requested_by_fk_idx
  on public.print_jobs(requested_by);

create index if not exists print_jobs_venue_account_fk_idx
  on public.print_jobs(venue_id,account_id);

create index if not exists print_jobs_venue_order_fk_idx
  on public.print_jobs(venue_id,order_id);

create index if not exists print_jobs_venue_device_fk_idx
  on public.print_jobs(venue_id,print_device_id);

create index if not exists refunds_authorized_by_fk_idx
  on public.refunds(authorized_by);

create index if not exists refunds_operator_fk_idx
  on public.refunds(operator_user_id);

create index if not exists refunds_venue_register_fk_idx
  on public.refunds(venue_id,cash_register_id);

create index if not exists refunds_venue_service_fk_idx
  on public.refunds(venue_id,service_session_id);
