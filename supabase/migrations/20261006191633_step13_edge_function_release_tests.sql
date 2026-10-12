
insert into private.release_test_catalog(key,category,required,description) values
  (
    'EDGE_FUNCTION_SECURITY_REVIEW',
    'SECURITY',
    true,
    'All live Edge Functions have reviewed authentication/public exposure, bounded input, server-side authorization or retired tombstone behavior.'
  ),
  (
    'EDGE_FUNCTION_OBSERVABILITY_24H',
    'REGRESSION',
    true,
    'Edge Function logs are reviewed for current-version 5xx regressions and continuity worker health.'
  )
on conflict(key) do nothing;
