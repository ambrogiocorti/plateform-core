
alter table public.venue_settings
  add column if not exists takeaway_order_mode text not null default 'DIRECT',
  add column if not exists takeaway_slot_interval_minutes integer not null default 15,
  add column if not exists takeaway_max_orders_per_slot integer,
  add column if not exists takeaway_max_items_per_slot integer,
  add column if not exists takeaway_minimum_order_cents bigint,
  add column if not exists takeaway_advance_order_limit_days integer not null default 30,
  add column if not exists takeaway_preparation_buffer_minutes integer not null default 15,
  add column if not exists takeaway_payment_modes_allowed public.payment_method[] not null
    default array['CASH'::public.payment_method];

alter table public.venue_settings
  drop constraint if exists venue_settings_takeaway_order_mode_check,
  add constraint venue_settings_takeaway_order_mode_check
    check(takeaway_order_mode in ('DIRECT','STAFF_APPROVAL')),
  drop constraint if exists venue_settings_takeaway_slot_interval_check,
  add constraint venue_settings_takeaway_slot_interval_check
    check(takeaway_slot_interval_minutes between 5 and 240),
  drop constraint if exists venue_settings_takeaway_max_orders_check,
  add constraint venue_settings_takeaway_max_orders_check
    check(takeaway_max_orders_per_slot is null or takeaway_max_orders_per_slot between 1 and 1000),
  drop constraint if exists venue_settings_takeaway_max_items_check,
  add constraint venue_settings_takeaway_max_items_check
    check(takeaway_max_items_per_slot is null or takeaway_max_items_per_slot between 1 and 10000),
  drop constraint if exists venue_settings_takeaway_minimum_order_check,
  add constraint venue_settings_takeaway_minimum_order_check
    check(takeaway_minimum_order_cents is null or takeaway_minimum_order_cents>=0),
  drop constraint if exists venue_settings_takeaway_advance_days_check,
  add constraint venue_settings_takeaway_advance_days_check
    check(takeaway_advance_order_limit_days between 0 and 90),
  drop constraint if exists venue_settings_takeaway_buffer_check,
  add constraint venue_settings_takeaway_buffer_check
    check(takeaway_preparation_buffer_minutes between 0 and 720),
  drop constraint if exists venue_settings_takeaway_payment_modes_check,
  add constraint venue_settings_takeaway_payment_modes_check
    check(cardinality(takeaway_payment_modes_allowed) between 1 and 5);

create or replace function public.configure_venue_operations(
  p_venue uuid,
  p_values jsonb
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  k text;
  config public.venue_settings;
begin
  perform private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  if jsonb_typeof(p_values)<>'object'
     or exists(
       select 1
       from jsonb_object_keys(p_values) x
       where x not in (
         'reservations_enabled',
         'customer_ordering',
         'customer_bill_request',
         'returns_enabled',
         'step_starter_roles',
         'delivery_routing',
         'sounds',
         'takeaway_order_mode',
         'takeaway_slot_interval_minutes',
         'takeaway_max_orders_per_slot',
         'takeaway_max_items_per_slot',
         'takeaway_minimum_order_cents',
         'takeaway_advance_order_limit_days',
         'takeaway_preparation_buffer_minutes',
         'takeaway_payment_modes_allowed'
       )
     )
  then
    raise exception 'INVALID_SETTINGS';
  end if;

  select *
  into config
  from public.venue_settings
  where venue_id=p_venue
  for update;

  if config.venue_id is null then
    raise exception 'NOT_FOUND';
  end if;

  if p_values ? 'customer_ordering'
     and p_values->>'customer_ordering'<>'DISABLED'
     and (p_values->>'customer_ordering') is distinct from config.customer_ordering::text
     and not exists(
       select 1
       from public.feature_flags
       where name='CLIENT_ORDERING'
         and licensed
     )
  then
    raise exception 'FEATURE_NOT_LICENSED';
  end if;

  if exists(
    select 1
    from jsonb_array_elements_text(
      coalesce(p_values->'takeaway_payment_modes_allowed','[]'::jsonb)
    ) m
    where m not in ('CASH','CARD_POS','STRIPE','SATISPAY_POS','SATISPAY_API')
  ) then
    raise exception 'INVALID_TAKEAWAY_PAYMENT_MODE';
  end if;

  for k in select jsonb_object_keys(p_values) loop
    execute format(
      'update public.venue_settings s set %I=r.%I from jsonb_populate_record(null::public.venue_settings,$1) r where s.venue_id=$2',
      k,k
    )
    using p_values,p_venue;
  end loop;
end
$$;

create or replace function private.audit_values(p_value jsonb)
returns jsonb
language sql
immutable
set search_path=''
as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)
  from jsonb_each(coalesce(p_value,'{}'::jsonb))
  where key=any(array[
    'id','venue_id','menu_id','public_menu_id','slug','published','weekdays','starts_at','ends_at',
    'available_from','available_until','sort_order','priority','display_mode','max_impressions_per_session',
    'reservation_id','event_type','channel','adapter','dedupe_key','state','scheduled_for','next_attempt_at',
    'attempts','max_attempts','provider_message_id','last_error_code','sent_at','delivered_at','failed_at','cancelled_at',
    'offset_minutes',
    'takeaway_order_mode','takeaway_slot_interval_minutes','takeaway_max_orders_per_slot',
    'takeaway_max_items_per_slot','takeaway_minimum_order_cents','takeaway_advance_order_limit_days',
    'takeaway_preparation_buffer_minutes','takeaway_payment_modes_allowed',
    'role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit','yield_factor','waste_percentage','removable',
    'ingredient_id','cost_micros','purchase_unit','effective_from','effective_to',
    'food_cost_micros','food_cost_cents','food_cost_percentage',
    'gross_margin_micros','gross_margin_cents','gross_margin_percentage','selling_price_cents','as_of',
    'unit_price_cents','amount_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by',
    'error_code','purpose'
  ])
$$;
