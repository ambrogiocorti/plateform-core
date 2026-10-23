
insert into private.release_gate_checks(key,category,required,status,evidence) values
  (
    'SOURCE_CONTROL_CI_PIPELINE',
    'CI_CD',
    true,
    'PENDING',
    'The current Plateform application source is not present in the connected GitHub repositories or mounted project files. Version the tested source and implement the full commit-to-production pipeline before go-live.'
  ),
  (
    'REQUIRED_DOCUMENTATION_SET',
    'DOCUMENTATION',
    true,
    'PENDING',
    'Complete and version README, ARCHITECTURE, DATABASE, SECURITY, PRIVACY, AUDIT, OBSERVABILITY, OFFLINE, DEPLOYMENT, OPERATIONS, RUNBOOK, BACKUP_RESTORE, INCIDENT_RESPONSE, TESTING and CHANGELOG with the final source.'
  )
on conflict(key) do update
set category=excluded.category,
    required=excluded.required,
    evidence=excluded.evidence,
    updated_at=clock_timestamp();
