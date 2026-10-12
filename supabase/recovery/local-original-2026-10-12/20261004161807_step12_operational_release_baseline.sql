begin;

create or replace function private.technical_workspace_base()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
begin
  perform private.authorize(null,array['SUPER_ADMIN']::public.user_role[],false);
  return jsonb_build_object(
    'profile',(select jsonb_build_object('name',name,'status',status,'version',version,'public_base_url',public_base_url,'staff_base_url',staff_base_url,'staff_identity_domain',staff_identity_domain) from public.restaurant_profile where id),
    'settings',(select to_jsonb(s) from public.restaurant_settings s where id),
    'limits',(select to_jsonb(l) from public.system_limits l where id),
    'features',coalesce((select jsonb_agg(to_jsonb(f) order by name) from public.feature_flags f),'[]'),
    'health',coalesce((select jsonb_agg(to_jsonb(x) order by component) from (select distinct on(component) component,status,latency_ms,code,checked_at from public.health_checks order by component,checked_at desc,id desc)x),'[]'),
    'backups',coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc) from(select * from public.backup_metadata order by created_at desc,id desc limit 10)x),'[]'),
    'releases',coalesce((select jsonb_agg(to_jsonb(x) order by released_at desc) from(select * from public.application_releases order by released_at desc,id desc limit 10)x),'[]'),
    'schema_version',(select max(version) from supabase_migrations.schema_migrations),
    'incidents',coalesce((select jsonb_agg(to_jsonb(x) order by started_at desc) from(select * from public.incidents where status<>'RESOLVED' order by started_at desc,id desc limit 50)x),'[]'),
    'usage',jsonb_build_object(
      'users',(select count(*) from public.staff_profiles where active),
      'venues',(select count(*) from public.venues where active),
      'tables',(select count(*) from public.tables where active),
      'dishes',(select count(*) from public.dishes where active),
      'devices',(select count(*) from public.registered_devices where revoked_at is null)+(select count(*) from public.print_devices where active),
      'recent_devices',(select count(*) from public.registered_devices where revoked_at is null and last_seen_at>now()-interval '5 minutes'),
      'sessions',(select count(*) from private.staff_sessions where revoked_at is null and unlocked_until>now()),
      'storage_bytes',(select coalesce(sum(size_bytes),0) from public.asset_uploads where status in ('RESERVED','SAVED'))
    ),
    'queues',jsonb_build_object(
      'offline_pending',(select count(*) from public.offline_sync_events where sync_status in ('PENDING','SYNCING')),
      'sync_conflicts',(select count(*) from public.sync_conflicts where status='OPEN'),
      'print_pending',(select count(*) from public.print_jobs where status='QUEUED'),
      'print_uncertain',(select count(*) from public.print_jobs where status in ('SENT','FAILED')),
      'provider_pending',(select count(*) from public.provider_operations where state in ('NEW','IN_FLIGHT','WAITING')),
      'provider_manual_review',(select count(*) from public.provider_operations where state in ('NEW','IN_FLIGHT','WAITING') and first_requested_at<now()-interval '20 hours' and provider_id is null),
      'staff_manual_review',(select count(*) from public.staff_admin_jobs where status='MANUAL_REVIEW')
    )
  );
end $$;

insert into public.application_releases(
  version,git_commit,build_id,released_by,database_schema_version,notes,status
)
select
  '0.1.0',
  'not-recorded',
  'development-baseline-0.1.0',
  'step12-baseline-migration',
  coalesce((select max(version) from supabase_migrations.schema_migrations),'unknown'),
  'Development metadata baseline for Operational Health. Not a production release or go-live certification.',
  'STAGING'
where not exists(
  select 1 from public.application_releases where build_id='development-baseline-0.1.0'
);

commit;