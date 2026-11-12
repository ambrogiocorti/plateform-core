
insert into private.release_test_catalog(key,category,required,description)
values(
  'POSTGRES_17_11_COMPATIBILITY',
  'REGRESSION',
  true,
  'Plateform is checked against Supabase PostgreSQL 17.11 breaking-change conditions for pgcrypto, ltree, btree_gist and custom operators.'
)
on conflict(key) do nothing;
