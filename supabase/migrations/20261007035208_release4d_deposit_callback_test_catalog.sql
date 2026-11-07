insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_DEPOSIT_SERVER_AUTHORITY','SECURITY',true,'Reservation deposit completion is service-role-only and atomically confirms the reservation; client roles cannot mark deposits paid.'),
  ('RESERVATION_DEPOSIT_CALLBACK_IDEMPOTENCY','CHAOS',true,'Deposit provider callback deduplicates provider events and rejects contradictory/out-of-order callbacks after completion.')
on conflict(key) do nothing;