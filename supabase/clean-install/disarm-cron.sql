-- Platform barrier for a fresh, isolated staging database. This is not an
-- application migration and never rewrites the canonical migration ledger.
-- Keep every historical cron.schedule call intact while preventing execution.
begin;
create schema plateform_installation;
revoke all on schema plateform_installation from public,anon,authenticated,service_role;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
do $fresh_cron$ begin
  if exists(select 1 from cron.job) then
    raise exception 'STAGING_CRON_BARRIER_REQUIRES_EMPTY_JOB_TABLE';
  end if;
end $fresh_cron$;
create function plateform_installation.plateform_disarm_cron_job()
returns trigger language plpgsql set search_path=pg_catalog as $barrier$
begin
  new.active := false;
  return new;
end
$barrier$;
revoke all on function plateform_installation.plateform_disarm_cron_job()
  from public,anon,authenticated,service_role;
create trigger plateform_staging_cron_disarmed
before insert or update on cron.job for each row
execute function plateform_installation.plateform_disarm_cron_job();
commit;
