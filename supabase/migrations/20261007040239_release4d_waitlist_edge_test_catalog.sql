insert into private.release_test_catalog(key,category,required,description)
values(
  'WAITLIST_EDGE_REACHABILITY',
  'REGRESSION',
  true,
  'Public waitlist Edge Function is deployed and returns controlled validation errors without exposing privileged DB APIs.'
)
on conflict(key) do nothing;