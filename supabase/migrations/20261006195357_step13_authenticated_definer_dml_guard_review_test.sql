
insert into private.release_test_catalog(key,category,required,description)
values(
  'AUTHENTICATED_DEFINER_DML_GUARD_REVIEW',
  'SECURITY',
  true,
  'Authenticated SECURITY DEFINER routines that mutate data must contain or delegate an explicit authorization guard.'
)
on conflict(key) do nothing;
