
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_CONFIRMATION_OUTBOX_EXACTLY_ONCE',
  'REGRESSION',
  true,
  'A RESERVED reservation creates one transactional outbox event and one deduplicated message job; repeated outbox processing does not duplicate the job.'
)
on conflict(key) do nothing;
