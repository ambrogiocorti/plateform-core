
insert into private.release_test_catalog(key,category,required,description)
values(
  'PRIVACY_DATA_RIGHTS_AUTHORIZATION_REVIEW',
  'SECURITY',
  true,
  'Privacy search/export/rectification/anonymization routines are reviewed for venue authorization, role boundaries, step-up protection, idempotency and audit.'
)
on conflict(key) do nothing;
