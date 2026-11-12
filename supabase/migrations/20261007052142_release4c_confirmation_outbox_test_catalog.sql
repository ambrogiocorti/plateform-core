
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_CONFIRMATION_OUTBOX_EXACTLY_ONCE',
  'REGRESSION',
  true,
  'A reservation entering RESERVED creates one transactional outbox event and one deduplicated confirmation job; repeated outbox runs do not duplicate delivery jobs.'
)
on conflict(key) do nothing;
