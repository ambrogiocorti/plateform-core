
insert into private.release_test_catalog(key,category,required,description) values
  (
    'OPERATIONAL_ASSIGNMENT_BYPASS',
    'SECURITY',
    true,
    'A staff user cannot perform assignment-scoped operations on an unassigned table/station/resource.'
  ),
  (
    'VENUE_ID_TAMPERING',
    'SECURITY',
    true,
    'Supplying a foreign venue_id to an authorized RPC does not bypass CHAIN/VENUE scope enforcement.'
  ),
  (
    'PERFORMANCE_HOT_PATH_INDEX_REVIEW',
    'REGRESSION',
    true,
    'Critical operational tables have no uncovered foreign-key indexes and no known duplicate indexes remain.'
  )
on conflict(key) do nothing;
