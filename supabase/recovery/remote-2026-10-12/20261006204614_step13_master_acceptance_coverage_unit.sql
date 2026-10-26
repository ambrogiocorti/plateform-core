
create table if not exists private.master_acceptance_requirements(
  key text primary key,
  section text not null
    check(section in ('UNIT','INTEGRATION','E2E','CHAOS','AUDIT','SECURITY','ADDITIONAL')),
  requirement text not null,
  required boolean not null default true,
  status text not null default 'PENDING'
    check(status in ('PENDING','PASS','FAIL')),
  mapped_test_key text,
  evidence jsonb not null default '{}'::jsonb
    check(jsonb_typeof(evidence)='object'),
  verified_at timestamptz,
  verified_by text,
  updated_at timestamptz not null default clock_timestamp()
);

alter table private.master_acceptance_requirements enable row level security;
revoke all on private.master_acceptance_requirements from public,anon,authenticated;

create or replace function public.master_acceptance_coverage_report()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
with base as (
  select *
  from private.master_acceptance_requirements
  where required
),
section_stats as (
  select section,
         count(*)::integer as seeded,
         count(*) filter(where status='PASS')::integer as passed,
         count(*) filter(where status<>'PASS')::integer as pending_or_failed
  from base
  group by section
),
agg as (
  select jsonb_object_agg(
           section,
           jsonb_build_object(
             'seeded',seeded,
             'passed',passed,
             'pending_or_failed',pending_or_failed
           )
           order by section
         ) as sections
  from section_stats
)
select jsonb_build_object(
  'ok',
    (select count(*) from base)=116
    and (select count(*) from base where status<>'PASS')=0,
  'expected_total',116,
  'seeded_total',(select count(*) from base),
  'passed',(select count(*) from base where status='PASS'),
  'pending_or_failed',(select count(*) from base where status<>'PASS'),
  'expected_by_section',jsonb_build_object(
    'UNIT',19,
    'INTEGRATION',16,
    'E2E',21,
    'CHAOS',16,
    'AUDIT',12,
    'SECURITY',23,
    'ADDITIONAL',9
  ),
  'sections',coalesce((select sections from agg),'{}'::jsonb)
)
$$;

revoke all on function public.master_acceptance_coverage_report()
from public,anon,authenticated;
grant execute on function public.master_acceptance_coverage_report()
to service_role,postgres;

create or replace function public.set_master_acceptance_result(
  p_key text,
  p_status text,
  p_mapped_test_key text,
  p_evidence jsonb,
  p_verified_by text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare v_row private.master_acceptance_requirements;
begin
  if p_key is null
     or p_status not in ('PENDING','PASS','FAIL')
     or p_evidence is null
     or jsonb_typeof(p_evidence)<>'object'
     or p_verified_by is null
     or length(trim(p_verified_by)) not between 2 and 160
  then
    raise exception 'INVALID_ACCEPTANCE_RESULT';
  end if;

  if p_status='PASS'
     and (p_mapped_test_key is null or length(trim(p_mapped_test_key))<3 or p_evidence='{}'::jsonb)
  then
    raise exception 'ACCEPTANCE_EVIDENCE_REQUIRED';
  end if;

  update private.master_acceptance_requirements
  set status=p_status,
      mapped_test_key=nullif(trim(p_mapped_test_key),''),
      evidence=p_evidence,
      verified_at=clock_timestamp(),
      verified_by=trim(p_verified_by),
      updated_at=clock_timestamp()
  where key=p_key
  returning * into v_row;

  if v_row.key is null then
    raise exception 'ACCEPTANCE_REQUIREMENT_NOT_FOUND';
  end if;

  return to_jsonb(v_row);
end
$$;

revoke all on function public.set_master_acceptance_result(text,text,text,jsonb,text)
from public,anon,authenticated;
grant execute on function public.set_master_acceptance_result(text,text,text,jsonb,text)
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.master_acceptance_coverage_report()','service_role'),
  ('public.set_master_acceptance_result(text,text,text,jsonb,text)','service_role')
on conflict do nothing;

insert into private.release_test_catalog(key,category,required,description)
values(
  'MASTER_ACCEPTANCE_COVERAGE',
  'REGRESSION',
  true,
  'All explicit Master Prompt acceptance requirements across Unit, Integration, E2E, Chaos, Audit, Security and additional acceptance cases are individually tracked and evidenced.'
)
on conflict(key) do nothing;

insert into private.master_acceptance_requirements(key,section,requirement) values
  ('UNIT_AVAILABILITY','UNIT','availability logic'),
  ('UNIT_ALLERGENS','UNIT','allergen logic'),
  ('UNIT_TOTALS','UNIT','financial totals'),
  ('UNIT_TIPS','UNIT','tip calculations'),
  ('UNIT_REFUNDS','UNIT','refund logic'),
  ('UNIT_VARIANTS','UNIT','variant logic'),
  ('UNIT_STATE_MACHINES','UNIT','state machine transitions'),
  ('UNIT_ACCOUNT_CODES','UNIT','account access-code logic'),
  ('UNIT_DISCOUNTS','UNIT','discount logic'),
  ('UNIT_BOOKING_PACING','UNIT','booking pacing'),
  ('UNIT_FOOD_COST_CONVERSIONS','UNIT','food cost and unit conversions'),
  ('UNIT_DISH_MARGIN','UNIT','dish margin calculation'),
  ('UNIT_MENU_ENGINEERING_CLASSIFICATION','UNIT','menu engineering classification'),
  ('UNIT_REMINDER_RULES','UNIT','reservation reminder rules'),
  ('UNIT_DEPOSIT_POLICY','UNIT','reservation deposit policy'),
  ('UNIT_WAITLIST_PRIORITY','UNIT','waitlist priority rules'),
  ('UNIT_TAKEAWAY_SLOT_CAPACITY','UNIT','takeaway pickup-slot capacity'),
  ('UNIT_CHAIN_VENUE_SCOPE','UNIT','chain/venue scope pure logic'),
  ('UNIT_CONFLICT_RESOLUTION_LOGIC','UNIT','conflict resolution pure logic')
on conflict(key) do nothing;
