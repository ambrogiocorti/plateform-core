alter table public.accounts
  add column if not exists account_type text not null default 'DINE_IN';

alter table public.accounts
  alter column table_id drop not null,
  alter column created_by drop not null;

alter table public.accounts
  drop constraint if exists accounts_account_type_check,
  add constraint accounts_account_type_check
    check(account_type in ('DINE_IN','TAKEAWAY')),
  drop constraint if exists accounts_table_by_type_check,
  add constraint accounts_table_by_type_check
    check(
      (account_type='DINE_IN' and table_id is not null)
      or (account_type='TAKEAWAY' and table_id is null)
    ),
  drop constraint if exists accounts_creator_by_type_check,
  add constraint accounts_creator_by_type_check
    check(account_type='TAKEAWAY' or created_by is not null),
  drop constraint if exists account_cover_limits,
  add constraint account_cover_limits
    check(
      ((covers between 1 and 1000) and account_type='DINE_IN' and not financial_partition)
      or (financial_partition and covers=0)
      or (account_type='TAKEAWAY' and covers=0 and not financial_partition)
    );

alter table public.orders
  alter column created_by drop not null,
  drop constraint if exists orders_origin_check,
  add constraint orders_origin_check
    check(origin in ('WAITER','CUSTOMER','OFFLINE','TAKEAWAY')),
  drop constraint if exists orders_creator_by_origin_check,
  add constraint orders_creator_by_origin_check
    check(origin='TAKEAWAY' or created_by is not null);

create table if not exists public.takeaway_pickup_slots(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  pickup_date date not null,
  pickup_time time not null,
  capacity_orders integer not null check(capacity_orders between 1 and 1000),
  closed boolean not null default false,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  unique(venue_id,pickup_date,pickup_time)
);

create table if not exists public.takeaway_orders(
  order_id uuid primary key references public.orders(id),
  venue_id uuid not null references public.venues(id),
  account_id uuid not null unique references public.accounts(id),
  pickup_slot_id uuid not null references public.takeaway_pickup_slots(id),
  pickup_at timestamptz not null,
  customer_name text not null check(length(trim(customer_name)) between 1 and 160),
  customer_phone text not null check(customer_phone ~ E'^\\+[0-9]{7,15}$'),
  customer_note text check(customer_note is null or length(customer_note)<=2000),
  status text not null default 'PLACED'
    check(status in ('PLACED','IN_PREPARATION','READY_FOR_PICKUP','COLLECTED','CANCELLED')),
  ready_at timestamptz,
  collected_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(status<>'READY_FOR_PICKUP' or ready_at is not null),
  check(status<>'COLLECTED' or (ready_at is not null and collected_at is not null))
);

create index if not exists takeaway_pickup_slots_venue_date_idx
on public.takeaway_pickup_slots(venue_id,pickup_date,pickup_time);

create index if not exists takeaway_orders_slot_idx
on public.takeaway_orders(pickup_slot_id,status,created_at);

create index if not exists takeaway_orders_venue_status_idx
on public.takeaway_orders(venue_id,status,pickup_at,created_at);

alter table public.takeaway_pickup_slots enable row level security;
alter table public.takeaway_orders enable row level security;

revoke all on table public.takeaway_pickup_slots from anon,authenticated;
revoke all on table public.takeaway_orders from anon,authenticated;
grant select on table public.takeaway_pickup_slots to authenticated;
grant select on table public.takeaway_orders to authenticated;

create policy takeaway_slots_staff_read
on public.takeaway_pickup_slots
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[])
  and private.has_venue(venue_id)
);

create policy takeaway_orders_staff_read
on public.takeaway_orders
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS']::public.user_role[])
  and private.has_venue(venue_id)
);

create or replace function private.account_admission_snapshot()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='INSERT' then
    new.admitted_covers:=case
      when new.financial_partition or new.account_type='TAKEAWAY' then 0
      else new.covers
    end;
  elsif new.admitted_covers is distinct from old.admitted_covers then
    raise exception 'IMMUTABLE_ADMISSION';
  end if;
  return new;
end
$$;

create or replace function private.release_account_floor(p_account uuid,p_table uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare members uuid[];
begin
  if p_table is null then return; end if;
  members:=private.table_group(p_table);
  if not exists(
    select 1 from public.accounts
    where table_id=any(members) and floor_released_at is null
  ) then
    update public.tables set technical_status='TO_RESET' where id=any(members);
  end if;
end
$$;

create or replace function private.guard_takeaway_order()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' then raise exception 'IMMUTABLE_TAKEAWAY_ORDER'; end if;

  if (
    to_jsonb(new)-array['status','ready_at','collected_at','version','updated_at','customer_note']
  ) is distinct from (
    to_jsonb(old)-array['status','ready_at','collected_at','version','updated_at','customer_note']
  ) then
    raise exception 'IMMUTABLE_TAKEAWAY_ORDER';
  end if;

  if old.status='PLACED' and new.status not in ('PLACED','IN_PREPARATION','READY_FOR_PICKUP','CANCELLED') then
    raise exception 'INVALID_TAKEAWAY_TRANSITION';
  elsif old.status='IN_PREPARATION' and new.status not in ('IN_PREPARATION','READY_FOR_PICKUP','CANCELLED') then
    raise exception 'INVALID_TAKEAWAY_TRANSITION';
  elsif old.status='READY_FOR_PICKUP' and new.status not in ('READY_FOR_PICKUP','COLLECTED','CANCELLED') then
    raise exception 'INVALID_TAKEAWAY_TRANSITION';
  elsif old.status in ('COLLECTED','CANCELLED') and new.status<>old.status then
    raise exception 'TAKEAWAY_TERMINAL';
  end if;

  return new;
end
$$;

create trigger takeaway_order_guard
before update or delete on public.takeaway_orders
for each row execute function private.guard_takeaway_order();

create trigger touch_version
before update on public.takeaway_pickup_slots
for each row execute function private.touch_version();
create trigger touch_version
before update on public.takeaway_orders
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update or delete on public.takeaway_pickup_slots
for each row execute function private.audit_row();
create trigger audit_mutation
after insert or update on public.takeaway_orders
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
    'offset_minutes','provider','provider_reference','amount_cents','refunded_amount_cents','expires_at','completed_at',
    'service_id','service_date','preferred_start_time','preferred_end_time','party_size','offered_at','offer_expires_at','confirmed_at','converted_reservation_id',
    'account_type','pickup_slot_id','pickup_at','ready_at','collected_at','origin',
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