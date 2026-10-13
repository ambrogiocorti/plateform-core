
create table if not exists private.ci_stage_catalog(
  stage text primary key,
  position integer not null unique,
  required boolean not null default true
);

create table if not exists private.ci_runs(
  id uuid primary key default gen_random_uuid(),
  version text not null,
  git_commit text not null,
  build_id text not null unique,
  target_environment text not null
    check(target_environment in ('development','staging','production')),
  status text not null default 'RUNNING'
    check(status in ('RUNNING','PASSED','FAILED','CANCELLED')),
  current_stage text references private.ci_stage_catalog(stage),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists private.ci_stage_results(
  run_id uuid not null references private.ci_runs(id) on delete cascade,
  stage text not null references private.ci_stage_catalog(stage),
  status text not null default 'PENDING'
    check(status in ('PENDING','RUNNING','PASS','FAIL')),
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(run_id,stage)
);

alter table private.ci_stage_catalog enable row level security;
alter table private.ci_runs enable row level security;
alter table private.ci_stage_results enable row level security;

revoke all on private.ci_stage_catalog,private.ci_runs,private.ci_stage_results
from public,anon,authenticated;

insert into private.ci_stage_catalog(stage,position,required) values
  ('COMMIT',10,true),
  ('FORMAT',20,true),
  ('LINT',30,true),
  ('TYPESCRIPT_CHECK',40,true),
  ('UNIT_TEST',50,true),
  ('MIGRATION_CHECK',60,true),
  ('RLS_TEST',70,true),
  ('SECURITY_TEST',80,true),
  ('INTEGRATION_TEST',90,true),
  ('BUILD',100,true),
  ('STAGING',110,true),
  ('E2E',120,true),
  ('RELEASE_GATE',130,true),
  ('PRODUCTION',140,true)
on conflict(stage) do update set
  position=excluded.position,
  required=excluded.required;

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

create or replace function public.record_ci_stage(
  p_run uuid,
  p_stage text,
  p_status text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_run private.ci_runs;
  v_stage private.ci_stage_catalog;
  v_result private.ci_stage_results;
  v_next text;
  v_readiness jsonb;
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
$$;

create or replace function public.get_ci_run(p_run uuid)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'run',to_jsonb(r),
    'stages',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'stage',c.stage,
          'position',c.position,
          'required',c.required,
          'status',s.status,
          'evidence',s.evidence,
          'started_at',s.started_at,
          'completed_at',s.completed_at
        )
        order by c.position
      )
      from private.ci_stage_catalog c
      join private.ci_stage_results s
        on s.run_id=r.id and s.stage=c.stage
    ),'[]'::jsonb)
  )
  from private.ci_runs r
  where r.id=p_run
$$;

revoke all on function public.begin_ci_run(text,text,text,text)
from public,anon,authenticated;
revoke all on function public.record_ci_stage(uuid,text,text,jsonb)
from public,anon,authenticated;
revoke all on function public.get_ci_run(uuid)
from public,anon,authenticated;

grant execute on function public.begin_ci_run(text,text,text,text)
to service_role,postgres;
grant execute on function public.record_ci_stage(uuid,text,text,jsonb)
to service_role,postgres;
grant execute on function public.get_ci_run(uuid)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.begin_ci_run(text,text,text,text)','service_role'),
  ('public.record_ci_stage(uuid,text,text,jsonb)','service_role'),
  ('public.get_ci_run(uuid)','service_role')
on conflict do nothing;
