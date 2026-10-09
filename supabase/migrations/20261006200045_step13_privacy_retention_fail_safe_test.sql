
insert into private.release_test_catalog(key,category,required,description)
values(
  'PRIVACY_RETENTION_FAIL_SAFE',
  'SECURITY',
  true,
  'Data retention is disabled by default, scheduled safely, service-role executed, and cannot purge data until an explicit customer policy is configured.'
)
on conflict(key) do nothing;
