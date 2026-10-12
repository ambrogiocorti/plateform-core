
insert into private.release_test_catalog(key,category,required,description) values
  ('RESERVATION_REMINDER_DEDUPLICATION','REGRESSION',true,'Reminder scheduler enqueues once, reuses an existing dedupe key on repeat runs and keeps reservation state unchanged.'),
  ('MESSAGE_WORKER_RETRY_RECONCILIATION','CHAOS',true,'Messaging worker deduplicates provider events, retries known temporary failures, and reconciles unknown outcomes without blind resend.'),
  ('MESSAGE_FAILURE_PRESERVES_RESERVATION','REGRESSION',true,'Messaging success/failure/retry/reconciliation never changes the reservation source-of-truth state.')
on conflict(key) do nothing;
