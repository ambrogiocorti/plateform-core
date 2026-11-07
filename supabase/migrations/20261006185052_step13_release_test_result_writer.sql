
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

revoke all on function public.record_release_test_result(text,text,jsonb,text)
from public,anon,authenticated;
grant execute on function public.record_release_test_result(text,text,jsonb,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.record_release_test_result(text,text,jsonb,text)','service_role')
on conflict do nothing;
