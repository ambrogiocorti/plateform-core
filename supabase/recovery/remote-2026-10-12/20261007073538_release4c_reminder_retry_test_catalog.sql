
insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_REMINDER_EXACTLY_ONCE_RETRY','REGRESSION',true,'Reservation reminder scheduling is deduplicated and retryable delivery reaches one final delivered job without duplicate callbacks.'),
  ('MESSAGE_PROVIDER_MOCK_INTEGRATION','REGRESSION',true,'Mock provider integration exercises claim, retry/backoff, provider idempotency and delivery callback processing.')
on conflict(key) do nothing;
