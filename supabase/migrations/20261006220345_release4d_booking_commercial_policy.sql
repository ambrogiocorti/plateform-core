
alter table public.service_booking_rules
  add column if not exists deposit_policy text not null default 'DISABLED',
  add column if not exists deposit_amount_cents bigint,
  add column if not exists deposit_percentage_bps integer,
  add column if not exists deposit_expiry_minutes integer,
  add column if not exists deposit_condition_mode text not null default 'ANY',
  add column if not exists deposit_min_party_size integer,
  add column if not exists deposit_weekdays integer[] not null default '{}'::integer[],
  add column if not exists deposit_dates date[] not null default '{}'::date[],
  add column if not exists deposit_start_time time,
  add column if not exists deposit_end_time time,
  add column if not exists no_show_mode text not null default 'NO_SHOW_MANUAL',
  add column if not exists no_show_grace_minutes integer not null default 15,
  add column if not exists deposit_no_show_action text not null default 'MANUAL',
  add column if not exists deposit_no_show_refund_bps integer,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default clock_timestamp();

alter table public.service_booking_rules
  drop constraint if exists service_booking_rules_deposit_policy_check,
  add constraint service_booking_rules_deposit_policy_check
    check(deposit_policy in ('DISABLED','OPTIONAL','REQUIRED','CONDITIONAL')),
  drop constraint if exists service_booking_rules_deposit_value_check,
  add constraint service_booking_rules_deposit_value_check
    check(
      deposit_amount_cents is null
      or deposit_amount_cents between 1 and 100000000
    ),
  drop constraint if exists service_booking_rules_deposit_percentage_check,
  add constraint service_booking_rules_deposit_percentage_check
    check(
      deposit_percentage_bps is null
      or deposit_percentage_bps between 1 and 10000
    ),
  drop constraint if exists service_booking_rules_deposit_one_value_check,
  add constraint service_booking_rules_deposit_one_value_check
    check(num_nonnulls(deposit_amount_cents,deposit_percentage_bps)<=1),
  drop constraint if exists service_booking_rules_deposit_active_value_check,
  add constraint service_booking_rules_deposit_active_value_check
    check(
      deposit_policy='DISABLED'
      or (
        num_nonnulls(deposit_amount_cents,deposit_percentage_bps)=1
        and deposit_expiry_minutes between 5 and 10080
      )
    ),
  drop constraint if exists service_booking_rules_deposit_expiry_check,
  add constraint service_booking_rules_deposit_expiry_check
    check(
      deposit_expiry_minutes is null
      or deposit_expiry_minutes between 5 and 10080
    ),
  drop constraint if exists service_booking_rules_condition_mode_check,
  add constraint service_booking_rules_condition_mode_check
    check(deposit_condition_mode in ('ANY','ALL')),
  drop constraint if exists service_booking_rules_min_party_check,
  add constraint service_booking_rules_min_party_check
    check(
      deposit_min_party_size is null
      or deposit_min_party_size between 1 and 1000
    ),
  drop constraint if exists service_booking_rules_condition_weekdays_check,
  add constraint service_booking_rules_condition_weekdays_check
    check(
      deposit_weekdays <@ array[1,2,3,4,5,6,7]
      and cardinality(deposit_weekdays)<=7
    ),
  drop constraint if exists service_booking_rules_condition_time_pair_check,
  add constraint service_booking_rules_condition_time_pair_check
    check((deposit_start_time is null)=(deposit_end_time is null)),
  drop constraint if exists service_booking_rules_conditional_has_condition_check,
  add constraint service_booking_rules_conditional_has_condition_check
    check(
      deposit_policy<>'CONDITIONAL'
      or deposit_min_party_size is not null
      or cardinality(deposit_weekdays)>0
      or cardinality(deposit_dates)>0
      or deposit_start_time is not null
    ),
  drop constraint if exists service_booking_rules_no_show_mode_check,
  add constraint service_booking_rules_no_show_mode_check
    check(no_show_mode in (
      'NO_SHOW_MANUAL',
      'NO_SHOW_SUGGESTED',
      'NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD'
    )),
  drop constraint if exists service_booking_rules_no_show_grace_check,
  add constraint service_booking_rules_no_show_grace_check
    check(no_show_grace_minutes between 0 and 240),
  drop constraint if exists service_booking_rules_no_show_deposit_action_check,
  add constraint service_booking_rules_no_show_deposit_action_check
    check(deposit_no_show_action in (
      'MANUAL','RETAIN','REFUND_FULL','PARTIAL_REFUND'
    )),
  drop constraint if exists service_booking_rules_no_show_refund_check,
  add constraint service_booking_rules_no_show_refund_check
    check(
      (
        deposit_no_show_action='PARTIAL_REFUND'
        and deposit_no_show_refund_bps between 1 and 9999
      )
      or (
        deposit_no_show_action<>'PARTIAL_REFUND'
        and deposit_no_show_refund_bps is null
      )
    );

drop trigger if exists touch_version on public.service_booking_rules;
create trigger touch_version
before update on public.service_booking_rules
for each row execute function private.touch_version();

create or replace function private.booking_deposit_policy_decision(
  p_service uuid,
  p_date date,
  p_time time,
  p_party integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  r public.service_booking_rules;
  v_conditions integer:=0;
  v_matches integer:=0;
  v_time_match boolean:=false;
  v_applies boolean:=false;
begin
  if p_service is null
     or p_date is null
     or p_time is null
     or p_party is null
     or p_party<1
  then
    raise exception 'INVALID_DEPOSIT_POLICY_INPUT';
  end if;

  select * into r
  from public.service_booking_rules
  where service_id=p_service;

  if r.service_id is null then
    raise exception 'BOOKING_RULES_NOT_FOUND';
  end if;

  if r.deposit_policy='DISABLED' then
    return jsonb_build_object(
      'policy','DISABLED',
      'requires_deposit',false,
      'deposit_optional',false
    );
  end if;

  if r.deposit_policy='OPTIONAL' then
    return jsonb_build_object(
      'policy','OPTIONAL',
      'requires_deposit',false,
      'deposit_optional',true,
      'amount_cents',r.deposit_amount_cents,
      'percentage_bps',r.deposit_percentage_bps,
      'expiry_minutes',r.deposit_expiry_minutes
    );
  end if;

  if r.deposit_policy='REQUIRED' then
    v_applies:=true;
  else
    if r.deposit_min_party_size is not null then
      v_conditions:=v_conditions+1;
      if p_party>=r.deposit_min_party_size then
        v_matches:=v_matches+1;
      end if;
    end if;

    if cardinality(r.deposit_weekdays)>0 then
      v_conditions:=v_conditions+1;
      if extract(isodow from p_date)::integer=any(r.deposit_weekdays) then
        v_matches:=v_matches+1;
      end if;
    end if;

    if cardinality(r.deposit_dates)>0 then
      v_conditions:=v_conditions+1;
      if p_date=any(r.deposit_dates) then
        v_matches:=v_matches+1;
      end if;
    end if;

    if r.deposit_start_time is not null then
      v_conditions:=v_conditions+1;

      if r.deposit_start_time=r.deposit_end_time then
        v_time_match:=true;
      elsif r.deposit_start_time<r.deposit_end_time then
        v_time_match:=p_time>=r.deposit_start_time
          and p_time<r.deposit_end_time;
      else
        v_time_match:=p_time>=r.deposit_start_time
          or p_time<r.deposit_end_time;
      end if;

      if v_time_match then
        v_matches:=v_matches+1;
      end if;
    end if;

    if r.deposit_condition_mode='ALL' then
      v_applies:=v_conditions>0 and v_matches=v_conditions;
    else
      v_applies:=v_matches>0;
    end if;
  end if;

  return jsonb_build_object(
    'policy',r.deposit_policy,
    'requires_deposit',v_applies,
    'deposit_optional',false,
    'amount_cents',case when v_applies then r.deposit_amount_cents end,
    'percentage_bps',case when v_applies then r.deposit_percentage_bps end,
    'expiry_minutes',case when v_applies then r.deposit_expiry_minutes end,
    'condition_mode',case when r.deposit_policy='CONDITIONAL' then r.deposit_condition_mode end,
    'conditions_evaluated',v_conditions,
    'conditions_matched',v_matches
  );
end
$$;

revoke all on function private.booking_deposit_policy_decision(
  uuid,date,time,integer
) from public,anon,authenticated;

create or replace function public.configure_booking_commercial_policy(
  p_venue uuid,
  p_service uuid,
  p_version bigint,
  p_deposit_policy text,
  p_deposit_amount_cents bigint,
  p_deposit_percentage_bps integer,
  p_deposit_expiry_minutes integer,
  p_condition_mode text,
  p_min_party_size integer,
  p_weekdays integer[],
  p_dates date[],
  p_start_time time,
  p_end_time time,
  p_no_show_mode text,
  p_no_show_grace_minutes integer,
  p_no_show_deposit_action text,
  p_no_show_refund_bps integer,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_policy text:=upper(trim(p_deposit_policy));
  v_condition_mode text:=upper(trim(coalesce(p_condition_mode,'ANY')));
  v_no_show_mode text:=upper(trim(p_no_show_mode));
  v_no_show_action text:=upper(trim(p_no_show_deposit_action));
  v_result jsonb;
  v_row public.service_booking_rules;
begin
  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if p_key is null
     or p_service is null
     or v_policy not in ('DISABLED','OPTIONAL','REQUIRED','CONDITIONAL')
     or v_condition_mode not in ('ANY','ALL')
     or v_no_show_mode not in (
       'NO_SHOW_MANUAL',
       'NO_SHOW_SUGGESTED',
       'NO_SHOW_AUTOMATIC_AFTER_GRACE_PERIOD'
     )
     or v_no_show_action not in (
       'MANUAL','RETAIN','REFUND_FULL','PARTIAL_REFUND'
     )
     or p_no_show_grace_minutes not between 0 and 240
     or num_nonnulls(p_deposit_amount_cents,p_deposit_percentage_bps)>1
     or (
       v_policy<>'DISABLED'
       and (
         num_nonnulls(p_deposit_amount_cents,p_deposit_percentage_bps)<>1
         or p_deposit_expiry_minutes not between 5 and 10080
       )
     )
     or (
       p_deposit_amount_cents is not null
       and p_deposit_amount_cents not between 1 and 100000000
     )
     or (
       p_deposit_percentage_bps is not null
       and p_deposit_percentage_bps not between 1 and 10000
     )
     or (
       p_min_party_size is not null
       and p_min_party_size not between 1 and 1000
     )
     or coalesce(p_weekdays,'{}'::integer[]) &> array[7]
     or exists(
       select 1
       from unnest(coalesce(p_weekdays,'{}'::integer[])) d
       where d not between 1 and 7
     )
     or (p_start_time is null)<>(p_end_time is null)
     or (
       v_policy='CONDITIONAL'
       and p_min_party_size is null
       and cardinality(coalesce(p_weekdays,'{}'::integer[]))=0
       and cardinality(coalesce(p_dates,'{}'::date[]))=0
       and p_start_time is null
     )
     or (
       v_no_show_action='PARTIAL_REFUND'
       and p_no_show_refund_bps not between 1 and 9999
     )
     or (
       v_no_show_action<>'PARTIAL_REFUND'
       and p_no_show_refund_bps is not null
     )
  then
    raise exception 'INVALID_BOOKING_COMMERCIAL_POLICY';
  end if;

  perform 1
  from public.services
  where id=p_service and venue_id=p_venue and active
  for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  select * into v_row
  from public.service_booking_rules
  where service_id=p_service
  for update;

  if v_row.service_id is null then
    raise exception 'BOOKING_RULES_NOT_FOUND';
  end if;

  if p_version is null or v_row.version<>p_version then
    raise exception 'VERSION_CONFLICT' using errcode='40001';
  end if;

  v_result:=private.idempotency_begin(
    'booking_commercial_policy',
    p_key,
    jsonb_build_object(
      'venue',p_venue,
      'service',p_service,
      'version',p_version,
      'deposit_policy',v_policy,
      'deposit_amount_cents',p_deposit_amount_cents,
      'deposit_percentage_bps',p_deposit_percentage_bps,
      'deposit_expiry_minutes',p_deposit_expiry_minutes,
      'condition_mode',v_condition_mode,
      'min_party_size',p_min_party_size,
      'weekdays',coalesce(p_weekdays,'{}'::integer[]),
      'dates',coalesce(p_dates,'{}'::date[]),
      'start_time',p_start_time,
      'end_time',p_end_time,
      'no_show_mode',v_no_show_mode,
      'no_show_grace_minutes',p_no_show_grace_minutes,
      'no_show_deposit_action',v_no_show_action,
      'no_show_refund_bps',p_no_show_refund_bps
    )
  );

  if v_result is not null then return v_result; end if;

  update public.service_booking_rules
  set deposit_policy=v_policy,
      deposit_amount_cents=p_deposit_amount_cents,
      deposit_percentage_bps=p_deposit_percentage_bps,
      deposit_expiry_minutes=p_deposit_expiry_minutes,
      deposit_condition_mode=v_condition_mode,
      deposit_min_party_size=p_min_party_size,
      deposit_weekdays=coalesce(p_weekdays,'{}'::integer[]),
      deposit_dates=coalesce(p_dates,'{}'::date[]),
      deposit_start_time=p_start_time,
      deposit_end_time=p_end_time,
      no_show_mode=v_no_show_mode,
      no_show_grace_minutes=p_no_show_grace_minutes,
      deposit_no_show_action=v_no_show_action,
      deposit_no_show_refund_bps=p_no_show_refund_bps
  where service_id=p_service
  returning * into v_row;

  v_result:=jsonb_build_object(
    'service_id',v_row.service_id,
    'version',v_row.version,
    'deposit_policy',v_row.deposit_policy,
    'no_show_mode',v_row.no_show_mode,
    'no_show_grace_minutes',v_row.no_show_grace_minutes
  );

  return private.idempotency_finish(
    'booking_commercial_policy',
    p_key,
    v_result
  );
end
$$;

revoke all on function public.configure_booking_commercial_policy(
  uuid,uuid,bigint,text,bigint,integer,integer,text,integer,integer[],date[],time,time,text,integer,text,integer,uuid
) from public,anon;

grant execute on function public.configure_booking_commercial_policy(
  uuid,uuid,bigint,text,bigint,integer,integer,text,integer,integer[],date[],time,time,text,integer,text,integer,uuid
) to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role)
values(
  'public.configure_booking_commercial_policy(uuid,uuid,bigint,text,bigint,integer,integer,text,integer,integer[],date[],time without time zone,time without time zone,text,integer,text,integer,uuid)',
  'authenticated'
)
on conflict do nothing;
