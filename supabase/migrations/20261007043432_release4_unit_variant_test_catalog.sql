
insert into private.release_test_catalog(key,category,required,description)
values(
  'VARIANT_SELECTION_RULES',
  'REGRESSION',
  true,
  'Required variant groups, max selection limits and valid variant snapshots are enforced transactionally without leaking failed orders.'
)
on conflict(key) do nothing;
