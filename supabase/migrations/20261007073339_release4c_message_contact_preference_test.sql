
insert into private.release_test_catalog(key,category,required,description)
values(
  'MESSAGE_CONTACT_PREFERENCE_OPT_OUT',
  'REGRESSION',
  true,
  'Verified reservation messaging contacts are channel-scoped; EMAIL can operate under RESERVATION_MESSAGING alone and explicit opt-out suppresses destination resolution.'
)
on conflict(key) do nothing;
