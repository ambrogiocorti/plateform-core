
create table if not exists private.release_documentation_requirements(
  key text primary key,
  filename text not null unique,
  required boolean not null default true,
  status text not null default 'PENDING'
    check(status in ('PENDING','PASS','FAIL')),
  source_ref text,
  evidence text,
  verified_at timestamptz,
  verified_by text,
  updated_at timestamptz not null default clock_timestamp()
);

alter table private.release_documentation_requirements enable row level security;
revoke all on private.release_documentation_requirements from public,anon,authenticated;

insert into private.release_documentation_requirements(key,filename) values
  ('README','README.md'),
  ('ARCHITECTURE','ARCHITECTURE.md'),
  ('DATABASE','DATABASE.md'),
  ('SECURITY','SECURITY.md'),
  ('PRIVACY','PRIVACY.md'),
  ('AUDIT','AUDIT.md'),
  ('OBSERVABILITY','OBSERVABILITY.md'),
  ('OFFLINE','OFFLINE.md'),
  ('DEPLOYMENT','DEPLOYMENT.md'),
  ('OPERATIONS','OPERATIONS.md'),
  ('RUNBOOK','RUNBOOK.md'),
  ('BACKUP_RESTORE','BACKUP_RESTORE.md'),
  ('INCIDENT_RESPONSE','INCIDENT_RESPONSE.md'),
  ('TESTING','TESTING.md'),
  ('CHANGELOG','CHANGELOG.md')
on conflict(key) do nothing;

create or replace function public.release_documentation_report()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'ok',count(*) filter(where required and status<>'PASS')=0,
    'required_total',count(*) filter(where required),
    'required_passed',count(*) filter(where required and status='PASS'),
    'required_pending_or_failed',count(*) filter(where required and status<>'PASS'),
    'documents',coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key',key,
          'filename',filename,
          'required',required,
          'status',status,
          'source_ref',source_ref,
          'evidence',evidence,
          'verified_at',verified_at,
          'verified_by',verified_by
        )
        order by key
      ),
      '[]'::jsonb
    )
  )
  from private.release_documentation_requirements
$$;

revoke all on function public.release_documentation_report()
from public,anon,authenticated;
grant execute on function public.release_documentation_report()
to service_role,postgres;

create or replace function public.set_release_documentation_item(
  p_key text,
  p_status text,
  p_source_ref text,
  p_evidence text,
  p_verified_by text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_row private.release_documentation_requirements;
  v_report jsonb;
begin
  if p_key is null
     or p_status not in ('PENDING','PASS','FAIL')
     or p_verified_by is null
     or length(trim(p_verified_by)) not between 2 and 160
     or length(coalesce(p_source_ref,''))>1000
     or length(coalesce(p_evidence,''))>4000
  then
    raise exception 'INVALID_DOCUMENTATION_RESULT';
  end if;

  update private.release_documentation_requirements
  set status=p_status,
      source_ref=nullif(trim(p_source_ref),''),
      evidence=nullif(trim(p_evidence),''),
      verified_at=clock_timestamp(),
      verified_by=trim(p_verified_by),
      updated_at=clock_timestamp()
  where key=p_key
  returning * into v_row;

  if v_row.key is null then
    raise exception 'DOCUMENTATION_ITEM_NOT_FOUND';
  end if;

  v_report:=public.release_documentation_report();

  update private.release_gate_checks
  set status=case
      when coalesce((v_report->>'ok')::boolean,false) then 'PASS'
      else 'PENDING'
    end,
    evidence=format(
      'Documentation gate: %s/%s required documents PASS.',
      v_report->>'required_passed',
      v_report->>'required_total'
    ),
    checked_at=clock_timestamp(),
    checked_by='documentation-gate',
    updated_at=clock_timestamp()
  where key='REQUIRED_DOCUMENTATION_SET';

  return to_jsonb(v_row);
end
$$;

revoke all on function public.set_release_documentation_item(text,text,text,text,text)
from public,anon,authenticated;
grant execute on function public.set_release_documentation_item(text,text,text,text,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.release_documentation_report()','service_role'),
  ('public.set_release_documentation_item(text,text,text,text,text)','service_role')
on conflict do nothing;
