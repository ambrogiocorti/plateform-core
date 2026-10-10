
create or replace function public.begin_ci_run(
  p_version text,
  p_git_commit text,
  p_build_id text,
  p_target_environment text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_run private.ci_runs;
begin
  if p_version is null or length(trim(p_version)) not between 1 and 100
     or p_git_commit is null or length(trim(p_git_commit)) not between 7 and 128
     or p_build_id is null or length(trim(p_build_id)) not between 3 and 200
     or p_target_environment not in ('development','staging','production')
  then
    raise exception 'INVALID_CI_RUN';
  end if;

  if p_target_environment in ('staging','production')
     and not exists(
       select 1
       from private.release_gate_checks
       where key='APPLICATION_STAGING_ENVIRONMENT'
         and required
         and status='PASS'
     )
  then
    raise exception 'CI_STAGING_ENVIRONMENT_NOT_READY';
  end if;

  if p_target_environment='production'
     and not exists(
       select 1
       from private.release_gate_checks
       where key='PRODUCTION_ENVIRONMENT_READY'
         and required
         and status='PASS'
     )
  then
    raise exception 'CI_PRODUCTION_ENVIRONMENT_NOT_READY';
  end if;

  insert into private.ci_runs(
    version,git_commit,build_id,target_environment,current_stage
  ) values(
    trim(p_version),trim(p_git_commit),trim(p_build_id),p_target_environment,'COMMIT'
  )
  returning * into v_run;

  insert into private.ci_stage_results(run_id,stage)
  select v_run.id,stage
  from private.ci_stage_catalog
  order by position;

  perform private.audit(
    'CI_RUN_STARTED',
    'ci_runs',
    v_run.id,
    null,
    null,
    jsonb_build_object(
      'version',v_run.version,
      'git_commit',v_run.git_commit,
      'build_id',v_run.build_id,
      'target_environment',v_run.target_environment
    ),
    'RECORDED'
  );

  return to_jsonb(v_run);
end
$$;
