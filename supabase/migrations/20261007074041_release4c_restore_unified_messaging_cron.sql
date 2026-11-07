
select cron.unschedule(jobid)
from cron.job
where jobname in (
  'plateform-message-outbox',
  'plateform-message-worker',
  'plateform-reservation-reminders'
);
