
insert into private.release_test_catalog(key,category,required,description)
values(
  'FOOD_COST_CONCURRENT_ANALYTICS',
  'CHAOS',
  true,
  'A concurrent ingredient-cost update does not alter an in-flight analytics statement; subsequent analytics sees the committed new cost.'
)
on conflict(key) do nothing;
