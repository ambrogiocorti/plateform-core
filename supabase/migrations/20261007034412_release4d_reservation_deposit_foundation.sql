create table if not exists public.reservation_deposits(
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id),
  venue_id uuid not null references public.venues(id),
  amount_cents bigint not null check(amount_cents>0),
  currency text not null default 'EUR' check(currency='EUR'),
  provider text check(provider in ('STRIPE','SATISPAY')),
  provider_reference text,
  status text not null default 'PENDING'
    check(status in ('PENDING','COMPLETED','FAILED','EXPIRED','REFUNDED','PARTIALLY_REFUNDED')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  refunded_amount_cents bigint not null default 0 check(refunded_amount_cents>=0),
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(provider_reference is null or length(provider_reference) between 1 and 240),
  check(refunded_amount_cents<=amount_cents),
  check((status in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED')) = (completed_at is not null)),
  check(status<>'REFUNDED' or refunded_amount_cents=amount_cents),
  check(status<>'PARTIALLY_REFUNDED' or (refunded_amount_cents>0 and refunded_amount_cents<amount_cents))
);

create unique index if not exists reservation_deposits_active_reservation_idx
on public.reservation_deposits(reservation_id)
where status in ('PENDING','COMPLETED','PARTIALLY_REFUNDED');

create unique index if not exists reservation_deposits_provider_reference_idx
on public.reservation_deposits(provider,provider_reference)
where provider_reference is not null;

create index if not exists reservation_deposits_venue_idx
on public.reservation_deposits(venue_id,created_at desc);

create index if not exists reservation_deposits_expiry_idx
on public.reservation_deposits(expires_at,id)
where status='PENDING';

alter table public.reservation_deposits enable row level security;
revoke all on table public.reservation_deposits from anon,authenticated;
grant select on table public.reservation_deposits to authenticated;

create policy reservation_deposits_staff_read
on public.reservation_deposits
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','HOST']::public.user_role[])
  and private.has_venue(venue_id)
);

create or replace function private.guard_reservation_deposit()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' then
    raise exception 'IMMUTABLE_RESERVATION_DEPOSIT';
  end if;

  if (
    to_jsonb(new)
      - array[
        'provider','provider_reference','status','completed_at',
        'refunded_amount_cents','version','updated_at'
      ]
  ) is distinct from (
    to_jsonb(old)
      - array[
        'provider','provider_reference','status','completed_at',
        'refunded_amount_cents','version','updated_at'
      ]
  ) then
    raise exception 'IMMUTABLE_RESERVATION_DEPOSIT';
  end if;

  if old.provider_reference is not null
     and new.provider_reference is distinct from old.provider_reference then
    raise exception 'IMMUTABLE_PROVIDER_REFERENCE';
  end if;

  if old.provider is not null
     and new.provider is distinct from old.provider then
    raise exception 'IMMUTABLE_DEPOSIT_PROVIDER';
  end if;

  if old.status='PENDING' and new.status not in ('PENDING','COMPLETED','FAILED','EXPIRED') then
    raise exception 'INVALID_DEPOSIT_TRANSITION';
  elsif old.status='COMPLETED' and new.status not in ('COMPLETED','PARTIALLY_REFUNDED','REFUNDED') then
    raise exception 'INVALID_DEPOSIT_TRANSITION';
  elsif old.status='PARTIALLY_REFUNDED' and new.status not in ('PARTIALLY_REFUNDED','REFUNDED') then
    raise exception 'INVALID_DEPOSIT_TRANSITION';
  elsif old.status in ('FAILED','EXPIRED','REFUNDED') and new.status<>old.status then
    raise exception 'DEPOSIT_TERMINAL';
  end if;

  return new;
end
$$;

create trigger reservation_deposit_guard
before update or delete on public.reservation_deposits
for each row execute function private.guard_reservation_deposit();

create trigger touch_version
before update on public.reservation_deposits
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update on public.reservation_deposits
for each row execute function private.audit_row();

create or replace function private.reservation_deposit_amount(
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
  v_policy jsonb;
  v_amount bigint;
begin
  v_policy:=private.booking_deposit_policy_decision(
    p_service,p_date,p_time,p_party
  );

  if not coalesce((v_policy->>'requires_deposit')::boolean,false) then
    return v_policy || jsonb_build_object('calculated_amount_cents',null);
  end if;

  if v_policy->>'amount_cents' is not null then
    v_amount:=(v_policy->>'amount_cents')::bigint;
  elsif v_policy->>'percentage_bps' is not null then
    raise exception 'DEPOSIT_PERCENTAGE_REQUIRES_BOOKING_VALUE';
  else
    raise exception 'INVALID_DEPOSIT_POLICY';
  end if;

  return v_policy || jsonb_build_object('calculated_amount_cents',v_amount);
end
$$;

revoke all on function private.reservation_deposit_amount(uuid,date,time,integer)
from public,anon,authenticated;

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
    'offset_minutes','provider','provider_reference','amount_cents','refunded_amount_cents','expires_at','completed_at',
    'role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit','yield_factor','waste_percentage','removable',
    'ingredient_id','cost_micros','purchase_unit','effective_from','effective_to',
    'food_cost_micros','food_cost_cents','food_cost_percentage',
    'gross_margin_micros','gross_margin_cents','gross_margin_percentage','selling_price_cents','as_of',
    'unit_price_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by',
    'error_code','purpose'
  ])
$$;