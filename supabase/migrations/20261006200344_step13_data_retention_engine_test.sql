
insert into private.release_test_catalog(key,category,required,description)
values(
  'DATA_RETENTION_ENGINE',
  'REGRESSION',
  true,
  'Technical privacy retention engine is fail-safe while unconfigured, uses explicit retention settings, protected configuration, scheduled execution and auditable anonymization/deletion.'
)
on conflict(key) do nothing;
