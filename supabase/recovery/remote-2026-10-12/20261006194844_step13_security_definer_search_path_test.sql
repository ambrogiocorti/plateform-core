
insert into private.release_test_catalog(key,category,required,description)
values(
  'SECURITY_DEFINER_SEARCH_PATH',
  'SECURITY',
  true,
  'Every application SECURITY DEFINER function has an explicit search_path configuration.'
)
on conflict(key) do nothing;
