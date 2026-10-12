
insert into private.release_test_catalog(key,category,required,description)
values(
  'DISCOUNT_QUOTE_UNIT_LOGIC',
  'REGRESSION',
  true,
  'Discount quote correctly computes fixed, percentage, item complimentary and account complimentary amounts and rejects discounts beyond unpaid balance.'
)
on conflict(key) do nothing;
