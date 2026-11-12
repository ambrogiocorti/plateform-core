CREATE OR REPLACE FUNCTION public.record_ci_stage(p_run uuid, p_stage text, p_status text, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_run private.ci_runs;
  v_stage private.ci_stage_catalog;
  v_result private.ci_stage_results;
  v_next text;
  v_readiness jsonb;
  v_gate jsonb;
begin
  if p_run is null
     or p_stage is null
     or p_status not in ('RUNNING','PASS','FAIL')
     or p_evidence is null
     or jsonb_typeof(p_evidence)<>'object'
  then
    raise exception 'INVALID_CI_STAGE_RESULT';
  end if;

  select * into v_run
  from private.ci_runs
  where id=p_run
  for update;

  if v_run.id is null then
    raise exception 'CI_RUN_NOT_FOUND';
  end if;

  if v_run.status<>'RUNNING' then
    raise exception 'CI_RUN_TERMINAL';
  end if;

  select * into v_stage
  from private.ci_stage_catalog
  where stage=p_stage;

  if v_stage.stage is null then
    raise exception 'CI_STAGE_NOT_FOUND';
  end if;

  if exists(
    select 1
    from private.ci_stage_catalog prior
    left join private.ci_stage_results r
      on r.run_id=v_run.id and r.stage=prior.stage
    where prior.required
      and prior.position<v_stage.position
      and coalesce(r.status,'PENDING')<>'PASS'
  ) then
    raise exception 'CI_STAGE_ORDER_VIOLATION';
  end if;

  if p_status='PASS' and p_stage='MIGRATION_CHECK' then
    v_gate:=public.release_database_regression_gate();
    if not coalesce((v_gate->>'ok')::boolean,false) then
      raise exception 'MIGRATION_GATE_FAILED';
    end if;
  end if;

  if p_status='PASS' and p_stage='RLS_TEST' then
    v_gate:=public.release_security_gate();
    if coalesce((v_gate->>'rls_disabled_tables')::integer,-1)<>0 then
      raise exception 'RLS_GATE_FAILED';
    end if;
  end if;

  if p_status='PASS' and p_stage='SECURITY_TEST' then
    v_gate:=public.release_security_gate();
    if not coalesce((v_gate->>'ok')::boolean,false) then
      raise exception 'SECURITY_GATE_FAILED';
    end if;
  end if;

  if p_status='PASS' and p_stage='RELEASE_GATE' then
    v_readiness:=public.release_readiness_report();
    if not coalesce((v_readiness->>'go_live_ready')::boolean,false) then
      raise exception 'RELEASE_GATE_BLOCKED';
    end if;
  end if;

  if p_status='PASS' and p_stage='PRODUCTION' then
    if v_run.target_environment<>'production' then
      raise exception 'PRODUCTION_TARGET_REQUIRED';
    end if;
    v_readiness:=public.release_readiness_report();
    if not coalesce((v_readiness->>'go_live_ready')::boolean,false) then
      raise exception 'PRODUCTION_RELEASE_BLOCKED';
    end if;
  end if;

  update private.ci_stage_results
  set status=p_status,
      evidence=p_evidence,
      started_at=case
        when p_status='RUNNING' then coalesce(started_at,clock_timestamp())
        else coalesce(started_at,clock_timestamp())
      end,
      completed_at=case when p_status in ('PASS','FAIL') then clock_timestamp() else null end,
      updated_at=clock_timestamp()
  where run_id=v_run.id and stage=p_stage
  returning * into v_result;

  if p_status='FAIL' then
    update private.ci_runs
    set status='FAILED',
        current_stage=p_stage,
        completed_at=clock_timestamp(),
        updated_at=clock_timestamp()
    where id=v_run.id;
  elsif p_status='PASS' then
    select stage into v_next
    from private.ci_stage_catalog
    where position>v_stage.position
    order by position
    limit 1;

    if v_next is null then
      update private.ci_runs
      set status='PASSED',
          current_stage=p_stage,
          completed_at=clock_timestamp(),
          updated_at=clock_timestamp()
      where id=v_run.id;

      insert into public.application_releases(
        version,git_commit,build_id,released_by,database_schema_version,notes,status
      ) values(
        v_run.version,
        v_run.git_commit,
        v_run.build_id,
        'ci-pipeline',
        (select version from supabase_migrations.schema_migrations order by version desc limit 1),
        'Release recorded after successful production CI stage.',
        'PRODUCTION'
      );
    else
      update private.ci_runs
      set current_stage=v_next,
          updated_at=clock_timestamp()
      where id=v_run.id;
    end if;
  end if;

  perform private.audit(
    'CI_STAGE_RECORDED',
    'ci_runs',
    v_run.id,
    null,
    null,
    jsonb_build_object(
      'stage',p_stage,
      'status',p_status,
      'evidence',p_evidence
    ),
    case when p_status='PASS' then 'SUCCESS' when p_status='FAIL' then 'FAILED' else 'RECORDED' end
  );

  return jsonb_build_object(
    'run_id',v_run.id,
    'stage',p_stage,
    'status',p_status,
    'next_stage',v_next
  );
end
$function$
