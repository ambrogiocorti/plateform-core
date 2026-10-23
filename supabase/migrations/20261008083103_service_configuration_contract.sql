begin;

alter table public.services
  drop constraint if exists services_name_check,
  add constraint services_name_check
    check(length(trim(name)) between 1 and 120),
  drop constraint if exists services_nonzero_window_check,
  add constraint services_nonzero_window_check
    check(starts_at<>ends_at),
  drop constraint if exists services_weekdays_cardinality_check,
  add constraint services_weekdays_cardinality_check
    check(cardinality(weekdays) between 1 and 7);

create or replace function private.test_service_configuration_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_save text;
begin
  select pg_get_functiondef('private.save_configuration_unchecked(text,uuid,uuid,jsonb,bigint)'::regprocedure)
  into v_save;

  if v_save not like '%when ''services'' then allowed:=array[''name'',''starts_at'',''ends_at'',''weekdays'',''active'']%' then
    raise exception 'SERVICE_CONFIGURATION_FIELDS_FAILED';
  end if;

  if not exists(
    select 1
    from pg_constraint c
    join pg_class r on r.oid=c.conrelid
    join pg_namespace n on n.oid=r.relnamespace
    where n.nspname='public'
      and r.relname='services'
      and c.conname='services_name_check'
      and c.convalidated
  ) or not exists(
    select 1
    from pg_constraint c
    join pg_class r on r.oid=c.conrelid
    join pg_namespace n on n.oid=r.relnamespace
    where n.nspname='public'
      and r.relname='services'
      and c.conname='services_nonzero_window_check'
      and c.convalidated
  ) or not exists(
    select 1
    from pg_constraint c
    join pg_class r on r.oid=c.conrelid
    join pg_namespace n on n.oid=r.relnamespace
    where n.nspname='public'
      and r.relname='services'
      and c.conname='services_weekdays_cardinality_check'
      and c.convalidated
  ) then
    raise exception 'SERVICE_CONFIGURATION_CONSTRAINTS_FAILED';
  end if;

  if not exists(
    select 1
    from information_schema.columns
    where table_schema='public' and table_name='service_booking_rules'
      and column_name='max_covers_service'
  ) or not exists(
    select 1
    from information_schema.columns
    where table_schema='public' and table_name='service_booking_rules'
      and column_name='max_arrivals_per_slot'
  ) then
    raise exception 'SERVICE_BOOKING_CAPACITY_FIELDS_FAILED';
  end if;

  return jsonb_build_object(
    'arbitrary_service_names',true,
    'bounded_name',true,
    'nonzero_service_window',true,
    'weekdays_required',true,
    'active_toggle',true,
    'service_capacity_rules',true
  );
end
$$;

revoke all on function private.test_service_configuration_contract()
from public,anon,authenticated;
grant execute on function private.test_service_configuration_contract()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description)
values(
  'SERVICE_CONFIGURATION_CONTRACT',
  'REGRESSION',
  true,
  'Restaurant services are Admin-managed arbitrary named schedules with bounded names, non-zero time windows, explicit active weekdays/status, and server-side booking capacity rules.'
)
on conflict(key) do nothing;

commit;