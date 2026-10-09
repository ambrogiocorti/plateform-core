
create table if not exists private.release_gate_checks(
  key text primary key,
  category text not null,
  required boolean not null default true,
  status text not null default 'PENDING'
    check(status in ('PENDING','PASS','FAIL')),
  evidence text,
  checked_at timestamptz,
  checked_by text,
  updated_at timestamptz not null default now()
);

alter table private.release_gate_checks enable row level security;

revoke all on private.release_gate_checks from public,anon,authenticated;

insert into private.release_gate_checks(key,category,required,status,evidence) values
  ('AUTH_LEAKED_PASSWORD_PROTECTION','SECURITY',true,'PENDING',
   'Enable Supabase Auth leaked-password protection and verify it in project configuration.'),
  ('DATABASE_OUTAGE_STAGING','CHAOS',true,'PENDING',
   'Run physical database-unavailable/fail-closed test in staging, not development.'),
  ('STRIPE_HTTPS_E2E','PAYMENTS',true,'PENDING',
   'Verify Checkout -> HTTPS return -> webhook -> Plateform ledger -> refund in staging/test.'),
  ('SATISPAY_SANDBOX_E2E','PAYMENTS',true,'PENDING',
   'Verify API payment, callback and refund against Satispay sandbox credentials.'),
  ('PRINT_BRIDGE_HARDWARE_E2E','PRINTING',true,'PENDING',
   'Verify printer/bridge offline-recovery path on compatible hardware.'),
  ('PWA_BROWSER_OFFLINE_E2E','OFFLINE',true,'PENDING',
   'Verify install/cache/offline queue/reconnect in a real browser/device.')
on conflict(key) do nothing;

create or replace function public.set_release_gate_check(
  p_key text,
  p_status text,
  p_evidence text,
  p_checked_by text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_old private.release_gate_checks;
  v_new private.release_gate_checks;
begin
  if p_key is null
     or p_status not in ('PENDING','PASS','FAIL')
     or p_checked_by is null
     or length(trim(p_checked_by)) not between 2 and 160
     or length(coalesce(p_evidence,''))>4000
  then
    raise exception 'INVALID_RELEASE_GATE_CHECK';
  end if;

  select * into v_old
  from private.release_gate_checks
  where key=p_key
  for update;

  if v_old.key is null then
    raise exception 'RELEASE_GATE_CHECK_NOT_FOUND';
  end if;

  update private.release_gate_checks
  set status=p_status,
      evidence=nullif(trim(p_evidence),''),
      checked_at=clock_timestamp(),
      checked_by=trim(p_checked_by),
      updated_at=clock_timestamp()
  where key=p_key
  returning * into v_new;

  perform private.audit(
    'RELEASE_GATE_CHECK_UPDATED',
    'release_gate_checks',
    null,
    null,
    to_jsonb(v_old),
    to_jsonb(v_new),
    case when p_status='PASS' then 'SUCCESS' else 'RECORDED' end
  );

  return to_jsonb(v_new);
end
$$;

revoke all on function public.set_release_gate_check(text,text,text,text)
from public,anon,authenticated;
grant execute on function public.set_release_gate_check(text,text,text,text)
to service_role,postgres;

create or replace function public.release_readiness_report()
returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $$
declare
  v_security jsonb;
  v_active_incidents integer;
  v_severe_incidents integer;
  v_active_backups integer;
  v_usable_backups integer;
  v_restore_tests integer;
  v_cron integer;
  v_manual_pending integer;
  v_internal_ready boolean;
  v_manual jsonb;
  v_release jsonb;
begin
  v_security:=public.release_security_gate();

  select count(*)::integer,
         count(*) filter(where severity in ('INCIDENT','CRITICAL'))::integer
    into v_active_incidents,v_severe_incidents
  from public.incidents
  where status::text<>'RESOLVED';

  select
    count(*) filter(where status in ('QUEUED','RUNNING'))::integer,
    count(*) filter(
      where status='SUCCEEDED'
        and integrity_verified
        and artifacts_purged_at is null
    )::integer
  into v_active_backups,v_usable_backups
  from public.backup_metadata;

  select count(*)::integer
    into v_restore_tests
  from public.restore_jobs
  where mode='TEST' and status='SUCCEEDED';

  select count(*)::integer
    into v_cron
  from cron.job
  where active
    and jobname in (
      'plateform-daily-backup',
      'plateform-continuity-alerts',
      'plateform-backup-worker',
      'plateform-retention-worker'
    );

  select count(*) filter(where required and status<>'PASS')::integer,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'key',key,
               'category',category,
               'required',required,
               'status',status,
               'evidence',evidence,
               'checked_at',checked_at,
               'checked_by',checked_by
             )
             order by category,key
           ),
           '[]'::jsonb
         )
    into v_manual_pending,v_manual
  from private.release_gate_checks;

  select to_jsonb(r)
    into v_release
  from public.application_releases r
  order by released_at desc
  limit 1;

  v_internal_ready:=
    coalesce((v_security->>'ok')::boolean,false)
    and v_active_incidents=0
    and v_severe_incidents=0
    and v_active_backups=0
    and v_usable_backups>0
    and v_restore_tests>0
    and v_cron=4;

  return jsonb_build_object(
    'internal_ready',v_internal_ready,
    'go_live_ready',v_internal_ready and v_manual_pending=0,
    'security',v_security,
    'continuity',jsonb_build_object(
      'active_incidents',v_active_incidents,
      'severe_incidents',v_severe_incidents,
      'active_backups',v_active_backups,
      'usable_verified_backups',v_usable_backups,
      'successful_restore_tests',v_restore_tests,
      'required_cron_jobs_active',v_cron
    ),
    'manual_required_pending',v_manual_pending,
    'manual_checks',v_manual,
    'latest_release',v_release,
    'checked_at',clock_timestamp()
  );
end
$$;

revoke all on function public.release_readiness_report()
from public,anon,authenticated;
grant execute on function public.release_readiness_report()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.set_release_gate_check(text,text,text,text)','service_role'),
  ('public.release_readiness_report()','service_role')
on conflict do nothing;
