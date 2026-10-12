
insert into private.release_test_catalog(key,category,required,description) values
  ('MESSAGE_OUTBOX_EXACT_ONCE','REGRESSION',true,'Reservation confirmation outbox enqueues exactly one message job per enabled channel and repeat processors do not duplicate it.'),
  ('REMINDER_SCHEDULER_DEDUPE','REGRESSION',true,'Reminder scheduler deduplicates retries, replaces stale schedules after booking-time changes and cancels pending reminders when the reservation leaves RESERVED.'),
  ('MESSAGE_DELIVERY_RETRY_IDEMPOTENCY','REGRESSION',true,'Message delivery uses leased retries, exponential backoff and idempotent provider delivery events.'),
  ('MESSAGE_TEMPLATE_SNAPSHOT','REGRESSION',true,'Queued message jobs freeze the selected template so later template edits do not alter already queued communication.'),
  ('MESSAGE_FAILURE_PRESERVES_RESERVATION','REGRESSION',true,'A terminal messaging failure does not modify or lose the authoritative reservation state.'),
  ('MESSAGE_WORKER_INTERNAL_AUTH','SECURITY',true,'Reservation message worker accepts the internal Vault-backed worker token, is scheduled server-side and returns HTTP 200 without exposing raw secrets.')
on conflict(key) do nothing;
