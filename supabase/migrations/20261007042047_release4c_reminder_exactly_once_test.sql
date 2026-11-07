
insert into private.release_test_catalog(key,category,required,description)
values(
  'REMINDER_EXACTLY_ONCE_WITH_RETRY',
  'CHAOS',
  true,
  'Reservation reminder scheduler deduplicates by reservation/rule/service time and retries the same job after a certain provider failure without creating a second reminder.'
)
on conflict(key) do nothing;
