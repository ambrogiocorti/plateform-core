
insert into private.release_test_catalog(key,category,required,description) values
  ('MESSAGE_DELIVERY_RETRY_DEDUP','REGRESSION',true,'Message worker leases jobs, retries only known failures with backoff, deduplicates provider events and reaches DELIVERED without duplicate state transitions.'),
  ('MESSAGE_UNKNOWN_OUTCOME_NO_AUTO_RETRY','SECURITY',true,'Unknown remote messaging outcomes enter UNKNOWN and are not automatically resent, preventing duplicate delivery risk.'),
  ('MESSAGE_OUTBOX_NO_CHANNEL_FAIL_CLOSED','REGRESSION',true,'Reservation message outbox remains pending with explicit error when no licensed operational channel is available.')
on conflict(key) do nothing;
