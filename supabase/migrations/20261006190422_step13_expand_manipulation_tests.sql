
insert into private.release_test_catalog(key,category,required,description) values
  (
    'PRICE_TAMPERING',
    'SECURITY',
    true,
    'Client-supplied price fields are rejected and order pricing remains server-authoritative.'
  ),
  (
    'AVAILABILITY_TAMPERING',
    'SECURITY',
    true,
    'Authenticated clients cannot directly mutate dish availability.'
  ),
  (
    'PAYMENT_STATUS_TAMPERING',
    'SECURITY',
    true,
    'Authenticated clients cannot directly mutate payment status.'
  )
on conflict(key) do nothing;
