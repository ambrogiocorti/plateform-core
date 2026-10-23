
insert into private.release_test_catalog(key,category,required,description)
values(
  'DOCUMENTATION_DRAFT_INTEGRITY',
  'REGRESSION',
  true,
  'All required documentation working drafts exist, are non-empty, explicitly marked DRAFT and contain no obvious hardcoded secrets/tokens before source-control versioning.'
)
on conflict(key) do nothing;
