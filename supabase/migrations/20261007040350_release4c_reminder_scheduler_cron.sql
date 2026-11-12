
insert into private.release_test_catalog(key,category,required,description)
values(
  'RESERVATION_REMINDER_DEDUPE_RESCHEDULE',
  'REGRESSION',
  true,
  'Reminder scheduler reuses the same dedupe key on repeated runs and cancels stale reminders when the reservation schedule changes.'
)
on conflict(key) do nothing;

select cron.schedule(
  'plateform-reservation-message-outbox',
  '* * * * *',
  'select public.run_reservation_message_outbox(100);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-reservation-message-outbox'
);

select cron.schedule(
  'plateform-reservation-reminder-scheduler',
  '*/5 * * * *',
  'select public.run_reservation_reminder_scheduler(clock_timestamp(),10,500);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-reservation-reminder-scheduler'
);
