
insert into private.release_test_catalog(key,category,required,description)
values(
  'CI_RELEASE_STATUS_ALIGNMENT',
  'REGRESSION',
  true,
  'Successful PRODUCTION CI stage records application release using the schema-valid RELEASED status.'
)
on conflict(key) do nothing;
