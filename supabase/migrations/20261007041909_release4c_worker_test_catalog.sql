
insert into private.release_test_catalog(key,category,required,description) values
  ('MESSAGE_UNKNOWN_OUTCOME_RECONCILIATION','CHAOS',true,
   'Unknown remote messaging outcome is never retried blindly and requires reconciliation without altering the reservation.'),
  ('MESSAGE_RETRY_DELIVERY_IDEMPOTENT','CHAOS',true,
   'Certain provider failure retries the same message job with backoff; successful delivery and duplicate provider events are idempotent.')
on conflict(key) do nothing;
