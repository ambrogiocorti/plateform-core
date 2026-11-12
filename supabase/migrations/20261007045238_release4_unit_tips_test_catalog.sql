
insert into private.release_test_catalog(key,category,required,description)
values(
  'TIPS_UNIT',
  'REGRESSION',
  true,
  'Tip validation rejects negative tips; a completed manual payment persists the tip exactly once without increasing account debt.'
)
on conflict(key) do nothing;
