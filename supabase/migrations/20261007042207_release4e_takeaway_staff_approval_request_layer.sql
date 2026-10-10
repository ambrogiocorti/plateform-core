
create table if not exists public.takeaway_requests(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  pickup_slot_id uuid not null references public.takeaway_pickup_slots(id),
  pickup_at timestamptz not null,
  customer_name text not null
    check(length(trim(customer_name)) between 1 and 160),
  customer_phone text not null
    check(customer_phone ~ '^\+[0-9]{7,15}$'),
  customer_note text
    check(customer_note is null or length(customer_note)<=2000),
  items jsonb not null
    check(jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 100),
  status text not null default 'PENDING_CONFIRMATION'
    check(status in ('PENDING_CONFIRMATION','CONFIRMED','REJECTED','EXPIRED','CANCELLED')),
  order_id uuid unique references public.orders(id),
  decision_deadline timestamptz not null,
  decided_by uuid references public.staff_profiles(id),
  decided_at timestamptz,
  rejection_reason text,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(decision_deadline<=pickup_at),
  check(
    (status='PENDING_CONFIRMATION' and decided_at is null and decided_by is null and order_id is null)
    or
    (status='CONFIRMED' and decided_at is not null and decided_by is not null and order_id is not null)
    or
    (status in ('REJECTED','EXPIRED','CANCELLED') and order_id is null)
  ),
  check(rejection_reason is null or length(trim(rejection_reason)) between 1 and 500)
);

alter table public.takeaway_requests enable row level security;

revoke all on table public.takeaway_requests from anon,authenticated;
grant select on table public.takeaway_requests to authenticated;

create policy takeaway_requests_staff_read
on public.takeaway_requests
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','PASS']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists takeaway_requests_slot_status_idx
on public.takeaway_requests(pickup_slot_id,status,created_at);

create index if not exists takeaway_requests_venue_status_idx
on public.takeaway_requests(venue_id,status,created_at desc);

create index if not exists takeaway_requests_decision_deadline_idx
on public.takeaway_requests(decision_deadline)
where status='PENDING_CONFIRMATION';

create index if not exists takeaway_requests_decided_by_idx
on public.takeaway_requests(decided_by)
where decided_by is not null;

create or replace function private.takeaway_item_count(p_items jsonb)
returns integer
language plpgsql
immutable
set search_path=''
as $$
declare
  v_line jsonb;
  v_total integer:=0;
  v_qty integer;
begin
  if p_items is null
     or jsonb_typeof(p_items)<>'array'
     or jsonb_array_length(p_items) not between 1 and 100
  then
    raise exception 'INVALID_ITEMS';
  end if;

  for v_line in
    select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_line)<>'object'
       or exists(
         select 1
         from jsonb_object_keys(v_line) k
         where k not in (
           'dish_id','quantity','step',
           'removed_ingredients','variant_options'
         )
       )
       or coalesce(v_line->>'dish_id','') !~ '^[0-9a-fA-F-]{36}$'
    then
      raise exception 'INVALID_ITEM_FIELDS';
    end if;

    begin
      v_qty:=(v_line->>'quantity')::integer;
    exception when others then
      raise exception 'INVALID_QUANTITY_OR_STEP';
    end;

    if v_qty is null or v_qty not between 1 and 999 then
      raise exception 'INVALID_QUANTITY_OR_STEP';
    end if;

    v_total:=v_total+v_qty;
    if v_total>10000 then
      raise exception 'TOO_MANY_ITEMS';
    end if;
  end loop;

  return v_total;
end
$$;

revoke all on function private.takeaway_item_count(jsonb)
from public,anon,authenticated;

create or replace function private.takeaway_slot_reserved_orders(
  p_slot uuid
)
returns integer
language sql
stable
security definer
set search_path=''
as $$
  select
    (
      select count(*)::integer
      from public.takeaway_orders tw
      where tw.pickup_slot_id=p_slot
        and tw.status<>'CANCELLED'
    )
    +
    (
      select count(*)::integer
      from public.takeaway_requests tr
      where tr.pickup_slot_id=p_slot
        and tr.status='PENDING_CONFIRMATION'
    )
$$;

revoke all on function private.takeaway_slot_reserved_orders(uuid)
from public,anon,authenticated;

create or replace function private.takeaway_slot_reserved_items(
  p_slot uuid
)
returns integer
language sql
stable
security definer
set search_path=''
as $$
  select
    coalesce((
      select sum(i.quantity)::integer
      from public.takeaway_orders tw
      join public.order_items i on i.order_id=tw.order_id
      where tw.pickup_slot_id=p_slot
        and tw.status<>'CANCELLED'
        and i.status<>'CANCELLED'
    ),0)
    +
    coalesce((
      select sum(private.takeaway_item_count(tr.items))::integer
      from public.takeaway_requests tr
      where tr.pickup_slot_id=p_slot
        and tr.status='PENDING_CONFIRMATION'
    ),0)
$$;

revoke all on function private.takeaway_slot_reserved_items(uuid)
from public,anon,authenticated;

create trigger touch_version
before update on public.takeaway_requests
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update on public.takeaway_requests
for each row execute function private.audit_row();

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
    'pickup_slot_id','pickup_at','decision_deadline','decided_by','decided_at','order_id',
    'takeaway_order_mode','takeaway_slot_interval_minutes','takeaway_max_orders_per_slot',
    'takeaway_max_items_per_slot','takeaway_minimum_order_cents','takeaway_advance_order_limit_days',
    'takeaway_preparation_buffer_minutes','takeaway_payment_modes_allowed',
    'role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit','yield_factor','waste_percentage','removable',
    'ingredient_id','cost_micros','purchase_unit','effective_from','effective_to',
    'food_cost_micros','food_cost_cents','food_cost_percentage',
    'gross_margin_micros','gross_margin_cents','gross_margin_percentage','selling_price_cents','as_of',
    'unit_price_cents','amount_cents','tip_cents','currency','method','account_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by',
    'error_code','purpose'
  ])
$$;
