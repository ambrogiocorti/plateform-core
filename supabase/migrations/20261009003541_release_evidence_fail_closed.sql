-- Legacy SQL-authored PASS rows are not proof of test execution.
-- Preserve their claims for audit while withdrawing release certification.
-- Until authenticated, immutable CI evidence ingestion is configured, ALL
-- success writes fail closed. This migration never creates a passing result.
begin;
update private.release_test_results
set evidence=jsonb_build_object(
      'classification','UNVERIFIED_LEGACY_CLAIM',
      'previous_status',status,'previous_evidence',evidence,
      'previous_executed_at',executed_at,'previous_executed_by',executed_by),
    status='PENDING',executed_at=null,executed_by=null,updated_at=clock_timestamp()
where status='PASS';

update private.release_gate_checks
set evidence='UNVERIFIED_LEGACY_CLAIM: '||jsonb_build_object(
      'previous_status',status,'previous_evidence',evidence,
      'previous_checked_at',checked_at,'previous_checked_by',checked_by)::text,
    status='PENDING',checked_at=null,checked_by=null,updated_at=clock_timestamp()
where status='PASS';

create or replace function private.reject_unattested_release_pass()
returns trigger language plpgsql security invoker set search_path=''
as $guard$
begin
  if new.status='PASS' then
    raise exception 'ATTESTED_CI_EVIDENCE_REQUIRED';
  end if;
  return new;
end
$guard$;
revoke all on function private.reject_unattested_release_pass()
from public,anon,authenticated,service_role;
create trigger reject_unattested_release_test_pass
before insert or update on private.release_test_results
for each row execute function private.reject_unattested_release_pass();
create trigger reject_unattested_release_gate_pass
before insert or update on private.release_gate_checks
for each row execute function private.reject_unattested_release_pass();


create or replace function public.record_release_test_result(
  p_key text,
  p_status text,
  p_evidence jsonb,
  p_executed_by text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_old private.release_test_results;
  v_new private.release_test_results;
begin
  if p_status='PASS' then
    raise exception 'ATTESTED_CI_EVIDENCE_REQUIRED';
  end if;
  if p_key is null
     or p_status not in ('PASS','FAIL','PENDING')
     or p_evidence is null
     or jsonb_typeof(p_evidence)<>'object'
     or p_executed_by is null
     or length(trim(p_executed_by)) not between 2 and 160
     or not exists(
       select 1 from private.release_test_catalog where key=p_key
     )
  then
    raise exception 'INVALID_RELEASE_TEST_RESULT';
  end if;

  select * into v_old
  from private.release_test_results
  where key=p_key;

  insert into private.release_test_results(
    key,status,evidence,executed_at,executed_by,updated_at
  ) values(
    p_key,p_status,p_evidence,clock_timestamp(),trim(p_executed_by),clock_timestamp()
  )
  on conflict(key) do update set
    status=excluded.status,
    evidence=excluded.evidence,
    executed_at=excluded.executed_at,
    executed_by=excluded.executed_by,
    updated_at=excluded.updated_at
  returning * into v_new;

  perform private.audit(
    'RELEASE_TEST_RESULT_RECORDED',
    'release_test_results',
    null,
    null,
    case when v_old.key is null then null else to_jsonb(v_old) end,
    to_jsonb(v_new),
    case when p_status='PASS' then 'SUCCESS' else p_status end
  );

  return to_jsonb(v_new);
end
$$;

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
  if p_status='PASS' then
    raise exception 'ATTESTED_CI_EVIDENCE_REQUIRED';
  end if;
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


create or replace function public.release_test_gate()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'ok',
      count(*) filter(where c.required)>0 and count(*) filter(
        where c.required
          and coalesce(r.status,'PENDING')<>'PASS'
      )=0,
    'required_total',count(*) filter(where c.required),
    'required_passed',count(*) filter(where c.required and r.status='PASS'),
    'required_pending_or_failed',count(*) filter(
      where c.required and coalesce(r.status,'PENDING')<>'PASS'
    ),
    'categories',coalesce((
      select jsonb_object_agg(category,summary order by category)
      from (
        select c2.category,
               jsonb_build_object(
                 'required',count(*) filter(where c2.required),
                 'passed',count(*) filter(where c2.required and r2.status='PASS'),
                 'pending_or_failed',count(*) filter(
                   where c2.required and coalesce(r2.status,'PENDING')<>'PASS'
                 )
               ) summary
        from private.release_test_catalog c2
        left join private.release_test_results r2 using(key)
        group by c2.category
      ) x
    ),'{}'::jsonb),
    'tests',coalesce(jsonb_agg(
      jsonb_build_object(
        'key',c.key,
        'category',c.category,
        'required',c.required,
        'status',coalesce(r.status,'PENDING'),
        'evidence',coalesce(r.evidence,'{}'::jsonb),
        'executed_at',r.executed_at,
        'executed_by',r.executed_by
      )
      order by c.category,c.key
    ),'[]'::jsonb)
  )
  from private.release_test_catalog c
  left join private.release_test_results r using(key)
$$;


insert into private.release_gate_checks(key,category,required,status,evidence)
values('RELEASE_EVIDENCE_PROVENANCE','RELEASE',true,'PENDING',
 'Authenticated CI execution, immutable log artifacts and commit/schema binding are required; unverified PASS writes remain blocked.')
on conflict(key) do nothing;
commit;
