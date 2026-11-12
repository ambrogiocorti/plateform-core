
insert into private.release_gate_checks(key,category,required,status,evidence) values
  (
    'APPLICATION_STAGING_ENVIRONMENT',
    'ENVIRONMENT',
    true,
    'PENDING',
    'Verified 2026-10-06: Supabase organization contains plateform-development and plateform-restore-test only; plateform-development has zero branches. A separate application staging environment is required before staging/E2E/chaos certification.'
  ),
  (
    'PRODUCTION_ENVIRONMENT_READY',
    'ENVIRONMENT',
    true,
    'PENDING',
    'Verified 2026-10-06: no dedicated Plateform production project/environment exists. Production must remain separate from development and restore-test.'
  )
on conflict(key) do update
set category=excluded.category,
    required=excluded.required,
    status=case when private.release_gate_checks.status='PASS' then 'PASS' else 'PENDING' end,
    evidence=excluded.evidence,
    updated_at=clock_timestamp();
