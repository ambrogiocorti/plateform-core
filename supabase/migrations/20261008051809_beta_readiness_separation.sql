
create or replace function public.beta_readiness_report()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_release jsonb;
  v_internal_ready boolean;
  v_go_live_ready boolean;
  v_blocking_pending integer;
  v_external_pending integer;
  v_manual jsonb;
  v_status text;
begin
  v_release:=public.release_readiness_report();
  v_internal_ready:=coalesce((v_release->>'internal_ready')::boolean,false);
  v_go_live_ready:=coalesce((v_release->>'go_live_ready')::boolean,false);

  with beta_policy(key,beta_blocking,pending_classification,rationale) as (
    values
      ('STRIPE_HTTPS_E2E'::text,false,'BETA READY — EXTERNAL VALIDATION PENDING'::text,'Real Stripe provider credentials/HTTPS webhook validation is a post-Beta external validation gate.'),
      ('SATISPAY_SANDBOX_E2E',false,'BETA READY — EXTERNAL VALIDATION PENDING','Real Satispay API sandbox credentials/callback validation is a post-Beta external validation gate.'),
      ('PRINT_BRIDGE_HARDWARE_E2E',false,'BETA READY — HARDWARE VALIDATION PENDING','Physical Epson/print bridge validation requires compatible hardware.'),
      ('APPLICATION_STAGING_ENVIRONMENT',false,'BLOCKED — EXTERNAL DEPENDENCY','Dedicated application staging is an environment validation dependency and does not make Development software falsely production-ready.'),
      ('PRODUCTION_ENVIRONMENT_READY',false,'BLOCKED — EXTERNAL DEPENDENCY','Production infrastructure is intentionally outside the Beta gate.'),
      ('DATABASE_OUTAGE_STAGING',false,'BLOCKED — EXTERNAL DEPENDENCY','Physical staging outage certification is deferred; controlled fail-closed database chaos is covered by the automatic test gate.'),
      ('PRIVACY_RETENTION_CONFIGURED',false,'BLOCKED — EXTERNAL DEPENDENCY','Customer/legal retention periods are deployment-specific; the technical engine remains fail-safe until explicitly configured.'),
      ('AUTH_LEAKED_PASSWORD_PROTECTION',false,'BLOCKED — EXTERNAL DEPENDENCY','Supabase Auth leaked-password protection is a platform configuration gate that must be enabled before Production.'),
      ('SOURCE_CONTROL_CI_PIPELINE',true,'IN PROGRESS','Beta requires reconciled source plus a reproducible source-control/CI pipeline.'),
      ('REQUIRED_DOCUMENTATION_SET',true,'IN PROGRESS','Beta requires the mandatory documentation set to be reconciled with the current source.'),
      ('PWA_BROWSER_OFFLINE_E2E',true,'IN PROGRESS','Browser installation/cache/offline/reconnect behavior is application functionality and must be validated before Beta completion.')
  ),
  pending as (
    select
      g.key,g.category,g.status,g.evidence,g.checked_at,g.checked_by,
      coalesce(p.beta_blocking,true) as beta_blocking,
      coalesce(p.pending_classification,'IN PROGRESS') as beta_classification,
      coalesce(p.rationale,'Unclassified required gate defaults to blocking.') as beta_rationale
    from private.release_gate_checks g
    left join beta_policy p on p.key=g.key
    where g.required and g.status<>'PASS'
  )
  select
    count(*) filter(where beta_blocking)::integer,
    count(*) filter(where not beta_blocking)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key',key,
          'category',category,
          'release_status',status,
          'beta_blocking',beta_blocking,
          'beta_classification',beta_classification,
          'rationale',beta_rationale,
          'evidence',evidence,
          'checked_at',checked_at,
          'checked_by',checked_by
        )
        order by beta_blocking desc,category,key
      ),
      '[]'::jsonb
    )
  into v_blocking_pending,v_external_pending,v_manual
  from pending;

  if not v_internal_ready then
    v_status:='IN PROGRESS';
  elsif v_blocking_pending>0 then
    v_status:='IN PROGRESS';
  elsif v_external_pending>0 then
    v_status:='BETA READY — EXTERNAL VALIDATION PENDING';
  else
    v_status:='COMPLETE';
  end if;

  return jsonb_build_object(
    'beta_ready',v_internal_ready and v_blocking_pending=0,
    'beta_status',v_status,
    'internal_ready',v_internal_ready,
    'go_live_ready',v_go_live_ready,
    'production_ready',v_go_live_ready,
    'blocking_pending',v_blocking_pending,
    'external_or_post_beta_pending',v_external_pending,
    'automatic_tests',v_release->'tests',
    'security',v_release->'security',
    'database',v_release->'database',
    'health',v_release->'health',
    'continuity',v_release->'continuity',
    'pending_gates',v_manual,
    'checked_at',clock_timestamp()
  );
end
$$;

revoke all on function public.beta_readiness_report() from public,anon,authenticated;
grant execute on function public.beta_readiness_report() to service_role;

create or replace function private.test_beta_readiness_separation()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_report jsonb;
  v_external_keys text[];
  v_blocking_keys text[];
  v_evidence jsonb;
begin
  v_report:=public.beta_readiness_report();

  select coalesce(array_agg(x->>'key' order by x->>'key'),'{}'::text[])
    into v_external_keys
  from jsonb_array_elements(v_report->'pending_gates') x
  where coalesce((x->>'beta_blocking')::boolean,true)=false;

  select coalesce(array_agg(x->>'key' order by x->>'key'),'{}'::text[])
    into v_blocking_keys
  from jsonb_array_elements(v_report->'pending_gates') x
  where coalesce((x->>'beta_blocking')::boolean,true)=true;

  if not ('STRIPE_HTTPS_E2E'=any(v_external_keys))
     or not ('SATISPAY_SANDBOX_E2E'=any(v_external_keys))
     or not ('PRINT_BRIDGE_HARDWARE_E2E'=any(v_external_keys))
  then raise exception 'BETA_EXTERNAL_EXCEPTION_CLASSIFICATION_FAILED'; end if;

  if not ('SOURCE_CONTROL_CI_PIPELINE'=any(v_blocking_keys))
     or not ('REQUIRED_DOCUMENTATION_SET'=any(v_blocking_keys))
     or not ('PWA_BROWSER_OFFLINE_E2E'=any(v_blocking_keys))
  then raise exception 'BETA_SOFTWARE_BLOCKER_CLASSIFICATION_FAILED'; end if;

  if coalesce((v_report->>'production_ready')::boolean,false) then
    raise exception 'BETA_GATE_MUST_NOT_BYPASS_PRODUCTION_GATE';
  end if;

  v_evidence:=jsonb_build_object(
    'release_internal_ready',v_report->'internal_ready',
    'production_gate_preserved',true,
    'stripe_real_e2e_nonblocking_beta',true,
    'satispay_real_e2e_nonblocking_beta',true,
    'epson_hardware_e2e_nonblocking_beta',true,
    'unknown_gate_policy','FAIL_CLOSED_BLOCKING',
    'current_beta_status',v_report->'beta_status',
    'blocking_pending',v_report->'blocking_pending',
    'external_or_post_beta_pending',v_report->'external_or_post_beta_pending'
  );
  return v_evidence;
end
$$;

revoke all on function private.test_beta_readiness_separation() from public,anon,authenticated;
grant execute on function private.test_beta_readiness_separation() to service_role;

insert into private.release_test_catalog(key,category,required,description)
values(
  'BETA_READINESS_SEPARATION',
  'REGRESSION',
  true,
  'Beta readiness is separated from Production go-live; real Stripe/Satispay and Epson hardware remain visible non-blocking Beta external gates while software/source/PWA blockers fail closed.'
)
on conflict(key) do update set
  category=excluded.category,
  required=excluded.required,
  description=excluded.description;
