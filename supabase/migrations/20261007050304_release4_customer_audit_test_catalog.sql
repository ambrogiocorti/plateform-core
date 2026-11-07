
insert into private.release_test_catalog(key,category,required,description)
values(
  'CUSTOMER_ACTION_AUDIT_ATTRIBUTION',
  'REGRESSION',
  true,
  'Public customer mutations are audited as CUSTOMER while preserving null staff identity and avoiding sensitive customer fields.'
)
on conflict(key) do nothing;
