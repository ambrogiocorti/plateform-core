
insert into private.release_test_catalog(key,category,required,description)
values(
  'PUBLIC_WAITLIST_EDGE_RATE_LIMIT_HARDENING',
  'SECURITY',
  true,
  'Public waitlist Edge derives join and acceptance rate-limit identity server-side from the trusted client IP, does not accept a browser-supplied rate key, validates bounded JSON input and remains reachable without JWT while preserving application-level validation.'
)
on conflict(key) do nothing;
