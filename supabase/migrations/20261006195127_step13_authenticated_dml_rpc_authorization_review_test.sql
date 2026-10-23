
insert into private.release_test_catalog(key,category,required,description)
values(
  'AUTHENTICATED_DML_RPC_AUTHORIZATION_REVIEW',
  'SECURITY',
  true,
  'Authenticated SECURITY DEFINER RPCs that mutate data have an application authorization guard; heuristic exceptions are manually reviewed.'
)
on conflict(key) do nothing;
