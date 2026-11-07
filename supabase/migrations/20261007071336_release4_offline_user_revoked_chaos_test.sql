
insert into private.release_test_catalog(key,category,required,description)
values(
  'OFFLINE_USER_REVOKED_DURING_SYNC',
  'CHAOS',
  true,
  'A valid offline snapshot is rejected as a conflict if the user is revoked before synchronization, with no domain mutation applied.'
)
on conflict(key) do nothing;
