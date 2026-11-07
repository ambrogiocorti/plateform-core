
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

  if p_status='PASS' and (
       p_source_ref is null
       or trim(p_source_ref) !~ '^git:[0-9a-f]{40,64}:[A-Za-z0-9._/-]+\.md$'
       or p_evidence is null
       or length(trim(p_evidence))<8
     )
  then
    raise exception 'DOCUMENTATION_VERSIONED_SOURCE_REQUIRED';
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
