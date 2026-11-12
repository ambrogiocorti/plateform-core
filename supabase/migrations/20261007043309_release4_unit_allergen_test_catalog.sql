
insert into private.release_test_catalog(key,category,required,description)
values(
  'ALLERGEN_SNAPSHOT_REMOVAL',
  'REGRESSION',
  true,
  'Order allergen snapshot is derived from non-removed ingredients; removing an authorized removable ingredient removes its allergens from the immutable order snapshot.'
)
on conflict(key) do nothing;
