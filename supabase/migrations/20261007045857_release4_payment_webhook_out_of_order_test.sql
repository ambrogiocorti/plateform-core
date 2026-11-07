
insert into private.release_test_catalog(key,category,required,description)
values(
  'PAYMENT_WEBHOOK_OUT_OF_ORDER',
  'CHAOS',
  true,
  'Completed provider operations ignore late WAITING callbacks and reject contradictory terminal callbacks without regressing state.'
)
on conflict(key) do nothing;
