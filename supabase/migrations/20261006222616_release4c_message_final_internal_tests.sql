
insert into private.release_test_catalog(key,category,required,description) values
  ('MESSAGE_TEMPLATE_VARIABLE_WHITELIST','SECURITY',true,'Reservation message templates accept only approved customer-facing variables and reject internal/arbitrary placeholders.'),
  ('MESSAGE_DELIVERY_EVENT_IDEMPOTENCY','REGRESSION',true,'Provider delivery callbacks transition SENT to DELIVERED idempotently and do not duplicate provider events.'),
  ('RESERVATION_MESSAGING_TICK_CRON','REGRESSION',true,'Reservation messaging cron is active, no-ops safely when no work exists, and invokes the worker only for due jobs.')
on conflict(key) do nothing;
