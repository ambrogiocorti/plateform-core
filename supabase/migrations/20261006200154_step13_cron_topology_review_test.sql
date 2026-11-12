
insert into private.release_test_catalog(key,category,required,description)
values(
  'CRON_TOPOLOGY_REVIEW',
  'REGRESSION',
  true,
  'All Plateform cron jobs are unique, active and their operational schedules/results are reviewed; newly introduced retention cron remains fail-safe until configured.'
)
on conflict(key) do nothing;
