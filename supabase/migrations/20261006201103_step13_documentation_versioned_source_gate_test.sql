
insert into private.release_test_catalog(key,category,required,description)
values(
  'DOCUMENTATION_VERSIONED_SOURCE_GATE',
  'REGRESSION',
  true,
  'Required documentation cannot pass the release gate unless it references a versioned Git Markdown source and has verification evidence.'
)
on conflict(key) do nothing;
