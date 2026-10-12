
insert into private.release_test_catalog(key,category,required,description)
values(
  'MESSAGE_DELIVERY_LEASE_RETRY_IDEMPOTENCY',
  'REGRESSION',
  true,
  'Message delivery claim/lease lifecycle retries transient failures with backoff and deduplicates provider events.'
)
on conflict(key) do nothing;
