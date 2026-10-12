
insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_REMINDER_EXACTLY_ONCE_RETRY','REGRESSION',true,'Reminder scheduler and delivery worker keep one logical reminder across retries, with stable dedupe and no duplicate scheduler enqueue.'),
  ('MESSAGE_FAILURE_PRESERVES_RESERVATION','REGRESSION',true,'Messaging provider failure/retry never mutates or loses the authoritative reservation.'),
  ('MESSAGE_RECONCILIATION_NO_RESEND','SECURITY',true,'Expired/unknown send outcomes require reconciliation and cannot be automatically reclaimed for resend.')
on conflict(key) do nothing;
