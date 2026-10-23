
insert into private.release_test_catalog(key,category,required,description)
values(
  'STEP_UP_GRANT_BINDING',
  'SECURITY',
  true,
  'Step-up grants are bound to user/session/action/resource, expire, and are single-use.'
)
on conflict(key) do nothing;
