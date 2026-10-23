
insert into private.release_test_catalog(key,category,required,description) values
  (
    'REFUND_STEP_UP_E2E',
    'SECURITY',
    true,
    'Verify refund end-to-end with ADMIN authorization, one-time step-up grant, idempotency, ledger update and audit.'
  ),
  (
    'FORCE_CLOSE_REOPEN_STEP_UP_E2E',
    'SECURITY',
    true,
    'Verify force-close and reopen account end-to-end with ADMIN authorization, one-time step-up grants, customer-session revocation and audit.'
  ),
  (
    'AUDIT_ROLE_ACCESS_E2E',
    'SECURITY',
    true,
    'Verify Super Admin can read the full audit search while Admin and lower roles cannot access the technical audit view.'
  )
on conflict(key) do nothing;
