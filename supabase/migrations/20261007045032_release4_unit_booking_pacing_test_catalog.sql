
insert into private.release_test_catalog(key,category,required,description)
values(
  'BOOKING_PACING_UNIT',
  'REGRESSION',
  true,
  'Booking pacing enforces service covers, per-slot arrivals and per-slot covers while excluding cancelled/no-show capacity.'
)
on conflict(key) do nothing;
