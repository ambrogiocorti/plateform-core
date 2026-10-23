
insert into private.release_test_catalog(key,category,required,description)
values(
  'RELEASE4_FEATURE_GATE_DEFAULT_DENY',
  'SECURITY',
  true,
  'Release 4 commercial modules are globally licensed and venue-enabled server-side; unlicensed modules fail closed and public payloads hide disabled features.'
)
on conflict(key) do nothing;
