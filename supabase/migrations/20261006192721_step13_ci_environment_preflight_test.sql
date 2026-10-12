
insert into private.release_test_catalog(key,category,required,description)
values(
  'CI_ENVIRONMENT_PREFLIGHT',
  'REGRESSION',
  true,
  'CI cannot start staging or production runs until the corresponding environment release gates are explicitly PASS.'
)
on conflict(key) do nothing;
