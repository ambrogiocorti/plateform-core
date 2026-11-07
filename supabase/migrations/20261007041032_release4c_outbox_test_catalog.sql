
insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_MESSAGE_OUTBOX_EXACTLY_ONCE','REGRESSION',true,
   'Reservation confirmation outbox creates exactly one delivery job per enabled channel and repeated processors do not duplicate it.'),
  ('RESERVATION_MESSAGE_PII_ISOLATION','SECURITY',true,
   'Message destination and template payload PII remain in private schema and are not exposed through public message job rows.')
on conflict(key) do nothing;
