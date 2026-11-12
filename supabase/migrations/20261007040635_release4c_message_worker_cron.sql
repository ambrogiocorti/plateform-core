
select cron.schedule(
  'plateform-reservation-message-worker',
  '* * * * *',
  'select public.invoke_reservation_message_worker(20);'
)
where not exists(
  select 1 from cron.job
  where jobname='plateform-reservation-message-worker'
);
