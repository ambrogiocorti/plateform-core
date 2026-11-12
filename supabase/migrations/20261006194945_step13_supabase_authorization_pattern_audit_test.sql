
insert into private.release_test_catalog(key,category,required,description)
values(
  'SUPABASE_AUTHORIZATION_PATTERN_AUDIT',
  'SECURITY',
  true,
  'Application policies and routines do not use deprecated auth.role() or user-editable user_metadata for authorization.'
)
on conflict(key) do nothing;
