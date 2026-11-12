
create or replace function public.release_database_regression_gate()
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_invalid_indexes integer;
  v_unvalidated_constraints integer;
  v_duplicate_versions integer;
  v_duplicate_names integer;
  v_required_extensions integer;
  v_required_cron_active integer;
  v_required_cron_success integer;
  v_stale_provider integer;
  v_stale_print integer;
  v_active_backups integer;
  v_active_restores integer;
  v_latest_version text;
  v_latest_name text;
begin
  select count(*)::integer
    into v_invalid_indexes
  from pg_catalog.pg_index
  where not indisvalid or not indisready;

  select count(*)::integer
    into v_unvalidated_constraints
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_namespace n on n.oid=c.connamespace
  where n.nspname in ('public','private')
    and not c.convalidated;

  select count(*)::integer
    into v_duplicate_versions
  from (
    select version
    from supabase_migrations.schema_migrations
    group by version
    having count(*)>1
  ) x;

  select count(*)::integer
    into v_duplicate_names
  from (
    select name
    from supabase_migrations.schema_migrations
    where name is not null
    group by name
    having count(*)>1
  ) x;

  select version,name
    into v_latest_version,v_latest_name
  from supabase_migrations.schema_migrations
  order by version desc
  limit 1;

  select count(*)::integer
    into v_required_extensions
  from pg_catalog.pg_extension
  where extname in ('pgcrypto','pg_cron','pg_net');

  select count(*)::integer
    into v_required_cron_active
  from cron.job
  where active
    and jobname in (
      'plateform-daily-backup',
      'plateform-continuity-alerts',
      'plateform-backup-worker',
      'plateform-retention-worker'
    );

  select count(*)::integer
    into v_required_cron_success
  from cron.job j
  where j.active
    and j.jobname in (
      'plateform-daily-backup',
      'plateform-continuity-alerts',
      'plateform-backup-worker',
      'plateform-retention-worker'
    )
    and (
      select d.status
      from cron.job_run_details d
      where d.jobid=j.jobid
      order by d.start_time desc
      limit 1
    )='succeeded';

  select count(*)::integer
    into v_stale_provider
  from public.provider_operations
  where state='IN_FLIGHT'
    and lease_until<clock_timestamp();

  select count(*)::integer
    into v_stale_print
  from public.print_jobs
  where status='SENT'
    and lease_until<clock_timestamp();

  select count(*)::integer
    into v_active_backups
  from public.backup_metadata
  where status in ('QUEUED','RUNNING');

  select count(*)::integer
    into v_active_restores
  from public.restore_jobs
  where status in (
    'REQUESTED','CONFIRMED','SNAPSHOTTING',
    'RESTORING','VERIFYING','CUTOVER_REQUIRED'
  );

  return jsonb_build_object(
    'ok',
      v_invalid_indexes=0
      and v_unvalidated_constraints=0
      and v_duplicate_versions=0
      and v_required_extensions=3
      and v_required_cron_active=4
      and v_required_cron_success=4
      and v_stale_provider=0
      and v_stale_print=0
      and v_active_backups=0
      and v_active_restores=0,
    'indexes',jsonb_build_object(
      'invalid_or_unready',v_invalid_indexes
    ),
    'constraints',jsonb_build_object(
      'unvalidated',v_unvalidated_constraints
    ),
    'migrations',jsonb_build_object(
      'duplicate_versions',v_duplicate_versions,
      'duplicate_names_warning',v_duplicate_names,
      'latest_version',v_latest_version,
      'latest_name',v_latest_name
    ),
    'extensions',jsonb_build_object(
      'required_present',v_required_extensions,
      'required_expected',3
    ),
    'cron',jsonb_build_object(
      'required_active',v_required_cron_active,
      'required_latest_succeeded',v_required_cron_success
    ),
    'operational_state',jsonb_build_object(
      'stale_provider_leases',v_stale_provider,
      'stale_print_leases',v_stale_print,
      'active_backups',v_active_backups,
      'active_restores',v_active_restores
    ),
    'checked_at',clock_timestamp()
  );
end
$$;

revoke all on function public.release_database_regression_gate()
from public,anon,authenticated;
grant execute on function public.release_database_regression_gate()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.release_database_regression_gate()','service_role')
on conflict do nothing;
