
insert into private.release_test_catalog(key,category,required,description)
values(
  'MENU_ENGINEERING_REPORT',
  'REGRESSION',
  true,
  'Menu engineering reuses billing-unit semantics, excludes voided units and returns period sales plus theoretical food cost, margin and classification.'
)
on conflict(key) do nothing;
