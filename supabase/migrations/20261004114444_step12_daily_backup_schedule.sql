begin;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname='plateform-daily-backup') then
    perform cron.unschedule('plateform-daily-backup');
  end if;
end $$;

select cron.schedule(
  'plateform-daily-backup',
  '30 2 * * *',
  $cron$select public.enqueue_scheduled_backup(30);$cron$
);

commit;