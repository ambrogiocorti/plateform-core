
insert into private.release_test_catalog(key,category,required,description)
values(
  'SUPABASE_SECURITY_ADVISOR_TRIAGE',
  'SECURITY',
  true,
  'Supabase security advisor findings are reviewed and either remediated, documented as intentional deny-all/public API, or tracked as an external go-live gate.'
)
on conflict(key) do nothing;
