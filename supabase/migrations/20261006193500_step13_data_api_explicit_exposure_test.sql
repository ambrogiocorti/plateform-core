
insert into private.release_test_catalog(key,category,required,description)
values(
  'DATA_API_EXPLICIT_EXPOSURE',
  'SECURITY',
  true,
  'Public Data API exposure is explicit: migration-owner defaults do not grant clients automatically, authenticated table grants are read-only, and anon table exposure is narrowly RLS-scoped.'
)
on conflict(key) do nothing;
