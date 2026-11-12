
insert into private.release_test_catalog(key,category,required,description)
values(
  'BACKUP_REPLICA_RATE_LIMIT_RECOVERY',
  'CHAOS',
  true,
  'Backup replication retries platform rate limits using provider retry timing and still completes with verified primary/replica integrity.'
)
on conflict(key) do nothing;
