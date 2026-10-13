
insert into private.release_test_catalog(key,category,required,description)
values(
  'READINESS_CORE_HEALTH_FAIL_CLOSED',
  'REGRESSION',
  true,
  'Release readiness becomes false when any core health component is degraded or stale.'
)
on conflict(key) do nothing;
