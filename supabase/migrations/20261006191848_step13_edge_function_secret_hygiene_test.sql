
insert into private.release_test_catalog(key,category,required,description)
values(
  'EDGE_FUNCTION_SECRET_HYGIENE',
  'SECURITY',
  true,
  'Edge Function source and runtime logs contain no hardcoded provider keys, bearer tokens or JWTs; provider secrets are read from environment.'
)
on conflict(key) do nothing;
