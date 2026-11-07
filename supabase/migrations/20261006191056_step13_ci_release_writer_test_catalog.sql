
insert into private.release_test_catalog(key,category,required,description)
values(
  'CI_RELEASE_WRITE_BOUNDARY',
  'REGRESSION',
  true,
  'service_role can drive the CI state machine but cannot insert a production release directly.'
)
on conflict(key) do nothing;
