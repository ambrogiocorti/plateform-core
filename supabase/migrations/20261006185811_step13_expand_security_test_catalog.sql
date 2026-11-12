
insert into private.release_test_catalog(key,category,required,description) values
  (
    'SINGLE_INSTALLATION_INVARIANT',
    'SECURITY',
    true,
    'A second restaurant/customer profile cannot be created in the same installation.'
  ),
  (
    'IDEMPOTENCY_REPLAY',
    'SECURITY',
    true,
    'Same idempotency key and payload replays the stored response; mismatched payload is rejected.'
  ),
  (
    'IMPERSONATION_READ_ONLY',
    'SECURITY',
    true,
    'Super Admin impersonation is read-only until explicit write enablement, and impersonated writes are audited.'
  )
on conflict(key) do nothing;
