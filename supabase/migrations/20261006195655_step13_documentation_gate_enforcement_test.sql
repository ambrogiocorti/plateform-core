
insert into private.release_test_catalog(key,category,required,description)
values(
  'DOCUMENTATION_GATE_ENFORCEMENT',
  'REGRESSION',
  true,
  'The final documentation set is tracked item-by-item and can only be verified by service-role automation; release gate remains pending until all required documents pass.'
)
on conflict(key) do nothing;
