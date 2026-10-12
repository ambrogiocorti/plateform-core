
begin;

create or replace function private.test_service_configuration_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_wrapper text;
  v_unchecked text;
  v_rules text;
  v_normalized text;
begin
  select pg_get_functiondef(
    'public.save_configuration(text,uuid,uuid,jsonb,bigint)'::regprocedure
  ) into v_wrapper;
  select pg_get_functiondef(
    'private.save_configuration_unchecked(text,uuid,uuid,jsonb,bigint)'::regprocedure
  ) into v_unchecked;
  select pg_get_functiondef(
    'public.configure_booking_rules(uuid,uuid,integer,integer,integer,integer,integer,text)'::regprocedure
  ) into v_rules;

  v_normalized:=regexp_replace(
    coalesce(v_wrapper,'')||coalesce(v_unchecked,'')||coalesce(v_rules,''),
    '[[:space:]]+','','g'
  );

  if not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services' and column_name='name'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services' and column_name='starts_at'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services' and column_name='ends_at'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services' and column_name='weekdays'
     )
     or not exists(
       select 1 from information_schema.columns
       where table_schema='public' and table_name='services' and column_name='active'
     )
     or v_normalized not like '%private.save_configuration_unchecked%'
     or v_normalized not like '%when''services''%'
     or v_normalized not like '%''name''%'
     or v_normalized not like '%''starts_at''%'
     or v_normalized not like '%''ends_at''%'
     or v_normalized not like '%''weekdays''%'
     or v_normalized not like '%''active''%'
     or v_normalized not like '%array[''ADMIN'']::public.user_role[]%'
     or v_normalized not like '%max_covers_service%'
     or v_normalized not like '%max_arrivals_per_slot%'
     or v_normalized not like '%max_covers_per_slot%'
     or lower(v_normalized) like '%lunch%'
     or lower(v_normalized) like '%dinner%'
  then
    raise exception 'SERVICE_CONFIGURATION_CONTRACT_FAILED';
  end if;

  return jsonb_build_object(
    'wrapper_delegates_to_allowlisted_editor',true,
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

commit;
