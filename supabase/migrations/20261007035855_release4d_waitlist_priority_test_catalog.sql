insert into private.release_test_catalog(key,category,required,description)
values(
  'WAITLIST_PRIORITY_ORDERING',
  'REGRESSION',
  true,
  'Waitlist candidates are ordered deterministically by temporal compatibility, then insertion time, then id; non-top compatible candidates cannot be offered first.'
)
on conflict(key) do nothing;