
insert into private.release_documentation_requirements(
  key,filename,required,status,source_ref,evidence,verified_at,verified_by,updated_at
)
values(
  'BETA_STATUS','BETA_STATUS.md',true,'PENDING',null,
  'Required by the Plateform Beta completion specification. Must document verified scope, Beta-ready external dependencies, hardware/provider validation pending, known limitations and Production checklist; current authoritative source file is not available in this session.',
  clock_timestamp(),'beta-spec-alignment',clock_timestamp()
)
on conflict(key) do update set
  filename=excluded.filename,
  required=true,
  status=case when private.release_documentation_requirements.status='PASS'
              then private.release_documentation_requirements.status else 'PENDING' end,
  evidence=case when private.release_documentation_requirements.status='PASS'
                then private.release_documentation_requirements.evidence else excluded.evidence end,
  verified_at=case when private.release_documentation_requirements.status='PASS'
                   then private.release_documentation_requirements.verified_at else clock_timestamp() end,
  verified_by=case when private.release_documentation_requirements.status='PASS'
                   then private.release_documentation_requirements.verified_by else 'beta-spec-alignment' end,
  updated_at=clock_timestamp();

update private.release_gate_checks
set status='PENDING',
    evidence='Beta documentation gate now requires 16 documents including BETA_STATUS.md. Existing local-git evidence references source commit 11dc9c0, but the authoritative current source tree is not available in this session; no documentation item is marked PASS until source/build reconciliation is verifiable.',
    checked_at=clock_timestamp(),
    checked_by='beta-spec-alignment',
    updated_at=clock_timestamp()
where key='REQUIRED_DOCUMENTATION_SET';

create or replace function private.test_beta_documentation_requirement()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'beta_status_required',
      exists(
        select 1 from private.release_documentation_requirements
        where key='BETA_STATUS'
          and filename='BETA_STATUS.md'
          and required
      ),
    'required_document_count',
      (select count(*) from private.release_documentation_requirements where required),
    'documentation_gate_fail_closed',
      not coalesce((public.release_documentation_report()->>'ok')::boolean,false),
    'beta_status_current_status',
      (select status from private.release_documentation_requirements where key='BETA_STATUS')
  )
$$;

revoke all on function private.test_beta_documentation_requirement() from public,anon,authenticated;
grant execute on function private.test_beta_documentation_requirement() to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'BETA_DOCUMENTATION_REQUIREMENT',
  'REGRESSION',
  true,
  'Beta documentation gate requires BETA_STATUS.md in addition to the mandatory technical documentation set and fails closed until source-backed verification exists.'
)
on conflict(key) do update set
  category=excluded.category,
  required=excluded.required,
  description=excluded.description;
