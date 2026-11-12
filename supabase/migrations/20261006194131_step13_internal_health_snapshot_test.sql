
insert into private.release_test_catalog(key,category,required,description)
values(
  'INTERNAL_HEALTH_SNAPSHOT',
  'REGRESSION',
  true,
  'Operational Health records fresh, truthful component states and never marks unverified external integrations healthy.'
)
on conflict(key) do nothing;
