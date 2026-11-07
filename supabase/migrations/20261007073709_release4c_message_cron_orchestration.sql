
select cron.schedule(
  'plateform-message-outbox',
  '* * * * *',
  'select public.run_reservation_message_outbox(200);'
)
where not exists(
  select 1 from cron.job where jobname='plateform-message-outbox'
);

select cron.schedule(
  'plateform-reservation-reminders',
  '*/5 * * * *',
  'select public.run_reservation_reminder_scheduler(clock_timestamp(),10,500);'
)
where not exists(
  select 1 from cron.job where jobname='plateform-reservation-reminders'
);

select cron.schedule(
  'plateform-message-worker',
  '* * * * *',
  'select public.invoke_reservation_message_worker(20);'
)
where not exists(
  select 1 from cron.job where jobname='plateform-message-worker'
);
