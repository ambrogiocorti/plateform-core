
select cron.unschedule('plateform-reservation-message-outbox')
where exists(select 1 from cron.job where jobname='plateform-reservation-message-outbox');

select cron.unschedule('plateform-reservation-message-worker')
where exists(select 1 from cron.job where jobname='plateform-reservation-message-worker');

select cron.unschedule('plateform-reservation-reminder-scheduler')
where exists(select 1 from cron.job where jobname='plateform-reservation-reminder-scheduler');
