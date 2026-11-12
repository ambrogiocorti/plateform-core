
begin;

alter table public.services
  drop constraint if exists services_name_length_check;
alter table public.services
  add constraint services_name_length_check
  check(length(trim(name)) between 1 and 160);

alter table public.services
  drop constraint if exists services_weekdays_nonempty_check;
alter table public.services
  add constraint services_weekdays_nonempty_check
  check(cardinality(weekdays) between 1 and 7);

create or replace function private.test_shift_planning_only_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_save text;
  v_local text;
  v_columns text[];
begin
  select pg_get_functiondef(
    'public.save_shift(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,bigint,uuid)'::regprocedure
  ) into v_save;
  select pg_get_functiondef(
    'public.save_shift_local(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone,bigint,uuid)'::regprocedure
  ) into v_local;
  select array_agg(column_name order by ordinal_position)
  into v_columns
  from information_schema.columns
  where table_schema='public' and table_name='shifts';

  if v_columns is distinct from array[
       'id','venue_id','staff_id','starts_at','ends_at','version','updated_at'
     ]
     or regexp_replace(v_save,'[[:space:]]+','','g')
        not like '%array[''ADMIN'']::public.user_role[]%'
     or v_save not like '%SHIFT_OVERLAP%'
     or v_save not like '%interval ''24 hours''%'
     or v_local not like '%NONEXISTENT_LOCAL_TIME%'
     or exists(
       select 1
       from information_schema.columns
       where table_schema='public' and table_name='shifts'
         and column_name in (
           'clock_in','clock_out','attendance','presence','late_minutes',
           'break_start','break_end','entry_at','exit_at'
         )
     )
  then
    raise exception 'SHIFT_PLANNING_ONLY_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'admin_only',true,
    'fields',to_jsonb(v_columns),
    'overlap_guard',true,
    'max_duration_hours',24,
    'timezone_safe_local_input',true,
    'attendance_tracking_present',false
  );
end
$$;

revoke all on function private.test_shift_planning_only_contract()
from public,anon,authenticated;
grant execute on function private.test_shift_planning_only_contract()
to service_role,postgres;

create or replace function private.test_service_configuration_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_config text;
  v_rules text;
  v_normalized text;
begin
  select pg_get_functiondef(
    'public.save_configuration(text,uuid,uuid,jsonb,bigint)'::regprocedure
  ) into v_config;
  select pg_get_functiondef(
    'public.configure_booking_rules(uuid,uuid,integer,integer,integer,integer,integer,text)'::regprocedure
  ) into v_rules;
  v_normalized:=regexp_replace(
    coalesce(v_config,'')||coalesce(v_rules,''),
    '[[:space:]]+','','g'
  );

  if not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services'
         and column_name='name'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services'
         and column_name='starts_at'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services'
         and column_name='ends_at'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services'
         and column_name='weekdays'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services'
         and column_name='active'
     )
     or v_normalized not like '%when''services''thenallowed:=array[''name'',''starts_at'',''ends_at'',''weekdays'',''active'']%'
     or v_normalized not like '%array[''ADMIN'']::public.user_role[]%'
     or v_normalized not like '%max_covers_service%'
     or v_normalized not like '%max_arrivals_per_slot%'
     or v_normalized not like '%max_covers_per_slot%'
     or v_normalized like '%lunch%'
     or v_normalized like '%dinner%'
  then
    raise exception 'SERVICE_CONFIGURATION_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'arbitrary_service_names',true,
    'starts_at',true,
    'ends_at',true,
    'weekdays',true,
    'active_state',true,
    'service_cover_limit',true,
    'slot_arrival_limit',true,
    'slot_cover_limit',true,
    'lunch_dinner_hardcoding',false
  );
end
$$;

revoke all on function private.test_service_configuration_contract()
from public,anon,authenticated;
grant execute on function private.test_service_configuration_contract()
to service_role,postgres;

insert into private.release_test_catalog(key,category,required,description) values
(
  'SHIFT_PLANNING_ONLY_CONTRACT',
  'REGRESSION',
  true,
  'Shift management is ADMIN-only planning with staff/start/end/version, overlap and timezone guards, and contains no attendance, clock-in/out, lateness or break tracking.'
),
(
  'SERVICE_CONFIGURATION_CONTRACT',
  'REGRESSION',
  true,
  'Restaurant services are arbitrary ADMIN-managed records with name, start/end time, weekdays, active state and booking/covers capacity; no lunch/dinner-only assumption exists.'
)
on conflict(key) do nothing;

commit;
