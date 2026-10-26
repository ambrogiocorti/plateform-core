
alter type public.reservation_status
  add value if not exists 'PENDING_DEPOSIT' after 'REQUESTED';

alter type public.reservation_status
  add value if not exists 'EXPIRED' after 'CANCELLED';
