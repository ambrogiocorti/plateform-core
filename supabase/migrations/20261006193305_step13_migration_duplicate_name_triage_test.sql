
insert into private.release_test_catalog(key,category,required,description)
values(
  'MIGRATION_HISTORY_DUPLICATE_NAME_TRIAGE',
  'REGRESSION',
  true,
  'Duplicate migration names are reviewed: versions must remain unique and differently named-history entries must not be rewritten.'
)
on conflict(key) do nothing;
