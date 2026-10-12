
insert into private.release_test_catalog(key,category,required,description)
values(
  'ACCOUNT_TOTALS_UNIT_CALCULATION',
  'REGRESSION',
  true,
  'Billing-unit account totals deterministically compute gross, discounts, net total, paid, pending, remaining and available amounts.'
)
on conflict(key) do nothing;
