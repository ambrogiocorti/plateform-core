
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_MESSAGING_ORCHESTRATION',
  'REGRESSION',
  true,
  'Unified reservation messaging cron executes outbox, reminder scheduling and worker dispatch without duplicate cron topology.'
)
on conflict(key) do nothing;
