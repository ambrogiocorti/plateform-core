
insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_MESSAGE_OUTBOX_EXACTLY_ONCE','REGRESSION',true,'Reservation confirmation outbox generates one deduplicated message job and repeated processing does not duplicate delivery work.')
on conflict(key) do nothing;
