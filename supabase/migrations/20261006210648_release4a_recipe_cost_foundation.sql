
alter table public.dish_ingredients
  add column if not exists quantity numeric(14,4),
  add column if not exists unit text,
  add column if not exists yield_factor numeric(8,6),
  add column if not exists waste_percentage numeric(6,3);

alter table public.dish_ingredients
  drop constraint if exists dish_ingredients_recipe_quantity_check,
  add constraint dish_ingredients_recipe_quantity_check
    check (quantity is null or quantity > 0),
  drop constraint if exists dish_ingredients_recipe_unit_check,
  add constraint dish_ingredients_recipe_unit_check
    check (unit is null or unit in ('G','KG','ML','L','PIECE')),
  drop constraint if exists dish_ingredients_recipe_pair_check,
  add constraint dish_ingredients_recipe_pair_check
    check ((quantity is null) = (unit is null)),
  drop constraint if exists dish_ingredients_yield_check,
  add constraint dish_ingredients_yield_check
    check (yield_factor is null or (yield_factor > 0 and yield_factor <= 1)),
  drop constraint if exists dish_ingredients_waste_check,
  add constraint dish_ingredients_waste_check
    check (waste_percentage is null or (waste_percentage >= 0 and waste_percentage < 100)),
  drop constraint if exists dish_ingredients_adjustment_requires_quantity_check,
  add constraint dish_ingredients_adjustment_requires_quantity_check
    check (
      (yield_factor is null and waste_percentage is null)
      or quantity is not null
    );

create table if not exists public.ingredient_cost_history(
  id uuid primary key default gen_random_uuid(),
  ingredient_id uuid not null references public.ingredients(id),
  venue_id uuid references public.venues(id),
  cost_micros bigint not null check(cost_micros > 0),
  currency text not null default 'EUR' check(currency='EUR'),
  purchase_unit text not null check(purchase_unit in ('G','KG','ML','L','PIECE')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  source text,
  created_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  check(effective_to is null or effective_to > effective_from),
  check(source is null or length(trim(source)) between 1 and 160)
);

alter table public.ingredient_cost_history enable row level security;

revoke all on table public.ingredient_cost_history from anon,authenticated;
grant select on table public.ingredient_cost_history to authenticated;

drop policy if exists ingredient_cost_admin_read on public.ingredient_cost_history;
create policy ingredient_cost_admin_read
on public.ingredient_cost_history
for select
to authenticated
using (
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and (venue_id is null or private.has_venue(venue_id))
);

create unique index if not exists ingredient_cost_history_one_current_idx
on public.ingredient_cost_history(
  ingredient_id,
  coalesce(venue_id,'00000000-0000-0000-0000-000000000000'::uuid)
)
where effective_to is null;

create index if not exists ingredient_cost_history_lookup_idx
on public.ingredient_cost_history(
  ingredient_id,
  venue_id,
  effective_from desc
);

create index if not exists ingredient_cost_history_venue_idx
on public.ingredient_cost_history(venue_id)
where venue_id is not null;

drop trigger if exists audit_mutation on public.ingredient_cost_history;
create trigger audit_mutation
after insert or update or delete on public.ingredient_cost_history
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
    'id','venue_id','role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit','yield_factor','waste_percentage','removable',
    'ingredient_id','cost_micros','purchase_unit','effective_from','effective_to',
    'unit_price_cents','amount_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at',
    'reason','gross_cents','discount_cents','total_cents','paid_cents','pending_cents','remaining_cents','available_cents',
    'original_payment_id','payment_id','source_account_id','target_account_id','kind','source_id','requested_by','resolved_by',
    'error_code','purpose'
  ])
$$;
