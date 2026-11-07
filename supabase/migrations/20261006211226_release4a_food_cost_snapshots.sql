
create table if not exists public.dish_food_cost_snapshots(
  id uuid primary key default gen_random_uuid(),
  dish_id uuid not null references public.dishes(id),
  venue_id uuid not null references public.venues(id),
  as_of timestamptz not null,
  currency text not null default 'EUR' check(currency='EUR'),
  selling_price_cents bigint not null check(selling_price_cents>=0),
  food_cost_micros bigint not null check(food_cost_micros>=0),
  food_cost_cents bigint not null check(food_cost_cents>=0),
  food_cost_percentage numeric(9,4) not null check(food_cost_percentage>=0),
  gross_margin_micros bigint not null,
  gross_margin_cents bigint not null,
  gross_margin_percentage numeric(9,4) not null,
  details jsonb not null check(jsonb_typeof(details)='object'),
  created_by uuid not null references public.staff_profiles(id),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.dish_food_cost_snapshots enable row level security;
revoke all on table public.dish_food_cost_snapshots from anon,authenticated;
grant select on table public.dish_food_cost_snapshots to authenticated;

drop policy if exists dish_food_cost_snapshots_admin_read
on public.dish_food_cost_snapshots;
create policy dish_food_cost_snapshots_admin_read
on public.dish_food_cost_snapshots
for select
to authenticated
using (
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists dish_food_cost_snapshots_lookup_idx
on public.dish_food_cost_snapshots(venue_id,dish_id,as_of desc);

create index if not exists dish_food_cost_snapshots_dish_idx
on public.dish_food_cost_snapshots(dish_id,as_of desc);

drop trigger if exists audit_mutation on public.dish_food_cost_snapshots;
create trigger audit_mutation
after insert on public.dish_food_cost_snapshots
for each row execute function private.audit_row();

drop trigger if exists immutable_snapshot on public.dish_food_cost_snapshots;
create trigger immutable_snapshot
before update or delete on public.dish_food_cost_snapshots
for each row execute function private.immutable_record();

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

create or replace function public.snapshot_dish_food_cost(
  p_dish uuid,
  p_venue uuid,
  p_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_result jsonb;
  v_cost jsonb;
  v_at timestamptz:=clock_timestamp();
  v_id uuid;
  v_price bigint;
begin
  if p_dish is null or p_venue is null or p_key is null then
    raise exception 'INVALID_FOOD_COST_SNAPSHOT';
  end if;

  v_actor:=private.authorize(p_venue,array['ADMIN']::public.user_role[]);

  v_result:=private.idempotency_begin(
    'dish_food_cost_snapshot',
    p_key,
    jsonb_build_object('dish',p_dish,'venue',p_venue)
  );
  if v_result is not null then return v_result; end if;

  select price_cents into v_price
  from public.dishes
  where id=p_dish;
  if v_price is null then raise exception 'NOT_FOUND'; end if;

  v_cost:=public.get_dish_food_cost(p_dish,p_venue,v_at);

  if not coalesce((v_cost->>'cost_complete')::boolean,false) then
    raise exception 'FOOD_COST_INCOMPLETE';
  end if;

  insert into public.dish_food_cost_snapshots(
    dish_id,venue_id,as_of,currency,selling_price_cents,
    food_cost_micros,food_cost_cents,food_cost_percentage,
    gross_margin_micros,gross_margin_cents,gross_margin_percentage,
    details,created_by
  ) values(
    p_dish,p_venue,(v_cost->>'as_of')::timestamptz,'EUR',v_price,
    (v_cost->>'food_cost_micros')::bigint,
    (v_cost->>'food_cost_cents')::bigint,
    (v_cost->>'food_cost_percentage')::numeric,
    (v_cost->>'gross_margin_micros')::bigint,
    (v_cost->>'gross_margin_cents')::bigint,
    (v_cost->>'gross_margin_percentage')::numeric,
    v_cost,
    v_actor
  )
  returning id into v_id;

  v_result:=jsonb_build_object('id',v_id,'snapshot',v_cost);
  return private.idempotency_finish('dish_food_cost_snapshot',p_key,v_result);
end
$$;

revoke all on function public.snapshot_dish_food_cost(uuid,uuid,uuid)
from public,anon;
grant execute on function public.snapshot_dish_food_cost(uuid,uuid,uuid)
to authenticated,service_role;

insert into private.api_permission_manifest(function_identity,api_role) values
  ('public.snapshot_dish_food_cost(uuid,uuid,uuid)','authenticated')
on conflict do nothing;
