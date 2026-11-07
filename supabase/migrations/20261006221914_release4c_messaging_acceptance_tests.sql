
insert into private.release_test_catalog(key,category,required,description) values
  ('MESSAGING_PROVIDER_FAILURE_PRESERVES_RESERVATION','CHAOS',true,'Messaging provider failure schedules retry or terminal failure without mutating or losing the reservation.'),
  ('REMINDER_EXACTLY_ONCE_WITH_RETRY','REGRESSION',true,'Reservation reminder scheduler reuses the same dedupe-key job across retries and repeated scheduler runs.')
on conflict(key) do nothing;
