
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
