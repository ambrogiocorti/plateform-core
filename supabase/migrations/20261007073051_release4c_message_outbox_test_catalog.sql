
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_MESSAGE_OUTBOX_EXACTLY_ONCE',
  'REGRESSION',
  true,
  'Reservation confirmation outbox creates at most one delivery job per reservation/channel even when the processor is rerun.'
)
on conflict(key) do nothing;
