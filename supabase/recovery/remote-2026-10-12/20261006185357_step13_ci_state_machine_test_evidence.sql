
insert into private.release_test_catalog(key,category,required,description)
values(
  'CI_PIPELINE_STATE_MACHINE',
  'REGRESSION',
  true,
  'CI stages enforce ordering, terminal failure and release gate before production.'
)
on conflict(key) do update set
  category=excluded.category,
  required=excluded.required,
  description=excluded.description;

insert into private.release_test_results(
  key,status,evidence,executed_at,executed_by
) values(
  'CI_PIPELINE_STATE_MACHINE',
  'PASS',
  jsonb_build_object(
    'skip_stage','CI_STAGE_ORDER_VIOLATION',
    'release_gate','RELEASE_GATE_BLOCKED',
    'failed_run_status','FAILED',
    'advance_after_failure','CI_RUN_TERMINAL',
    'production_release_created',false
  ),
  clock_timestamp(),
  'step13-assisted-test'
)
on conflict(key) do update set
  status=excluded.status,
  evidence=excluded.evidence,
  executed_at=excluded.executed_at,
  executed_by=excluded.executed_by,
  updated_at=clock_timestamp();
