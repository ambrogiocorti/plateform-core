
create table if not exists public.menus(
  id uuid primary key default gen_random_uuid(),
  public_menu_id uuid not null unique default gen_random_uuid(),
  name text not null check(length(trim(name)) between 1 and 120),
  slug text not null unique
    check(length(slug) between 2 and 80)
    check(slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  active boolean not null default true,
  published boolean not null default false,
  weekdays integer[] not null default array[1,2,3,4,5,6,7],
  starts_at time,
  ends_at time,
  available_from date,
  available_until date,
  sort_order integer not null default 0,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  check(weekdays <@ array[1,2,3,4,5,6,7] and cardinality(weekdays) between 1 and 7),
  check((starts_at is null)=(ends_at is null)),
  check(available_until is null or available_from is null or available_until>=available_from)
);

create table if not exists public.menu_venues(
  menu_id uuid not null references public.menus(id) on delete cascade,
  venue_id uuid not null references public.venues(id),
  sort_order integer not null default 0,
  primary key(menu_id,venue_id)
);

create table if not exists public.menu_categories(
  menu_id uuid not null references public.menus(id) on delete cascade,
  category_id uuid not null references public.categories(id),
  sort_order integer not null default 0,
  primary key(menu_id,category_id)
);

create table if not exists public.menu_dishes(
  menu_id uuid not null references public.menus(id) on delete cascade,
  dish_id uuid not null references public.dishes(id),
  sort_order integer not null default 0,
  primary key(menu_id,dish_id)
);

create table if not exists public.menu_promotions(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id),
  menu_id uuid references public.menus(id),
  display_mode text not null
    check(display_mode in ('BANNER','CARD','BADGE','POPUP')),
  title text not null check(length(trim(title)) between 1 and 160),
  body text,
  image_path text,
  cta_label text,
  target_category_id uuid references public.categories(id),
  target_dish_id uuid references public.dishes(id),
  target_menu_id uuid references public.menus(id),
  start_at timestamptz not null,
  end_at timestamptz,
  priority integer not null default 0,
  max_impressions_per_session integer
    check(max_impressions_per_session is null or max_impressions_per_session between 1 and 100),
  active boolean not null default true,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  check(end_at is null or end_at>start_at),
  check(num_nonnulls(target_category_id,target_dish_id,target_menu_id)<=1)
);

create index if not exists menu_venues_venue_idx
on public.menu_venues(venue_id,sort_order,menu_id);

create index if not exists menu_categories_category_idx
on public.menu_categories(category_id,menu_id);

create index if not exists menu_dishes_dish_idx
on public.menu_dishes(dish_id,menu_id);

create index if not exists menu_promotions_active_window_idx
on public.menu_promotions(active,start_at,end_at,priority desc);

create index if not exists menu_promotions_venue_idx
on public.menu_promotions(venue_id)
where venue_id is not null;

create index if not exists menu_promotions_menu_idx
on public.menu_promotions(menu_id)
where menu_id is not null;

alter table public.menus enable row level security;
alter table public.menu_venues enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_dishes enable row level security;
alter table public.menu_promotions enable row level security;

revoke all on table
  public.menus,
  public.menu_venues,
  public.menu_categories,
  public.menu_dishes,
  public.menu_promotions
from anon,authenticated;

grant select on table
  public.menus,
  public.menu_venues,
  public.menu_categories,
  public.menu_dishes,
  public.menu_promotions
to authenticated;

create or replace function private.can_read_menu(p_menu uuid)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    private.installation_active()
    and private.is_role(array['ADMIN']::public.user_role[])
    and (
      private.can_manage_shared_catalog()
      or exists(
        select 1
        from public.menu_venues mv
        where mv.menu_id=p_menu
          and private.has_venue(mv.venue_id)
      )
    )
$$;

revoke all on function private.can_read_menu(uuid)
from public,anon,authenticated;

drop policy if exists menu_admin_read on public.menus;
create policy menu_admin_read
on public.menus
for select
to authenticated
using(private.can_read_menu(id));

drop policy if exists menu_venues_admin_read on public.menu_venues;
create policy menu_venues_admin_read
on public.menu_venues
for select
to authenticated
using(private.can_read_menu(menu_id));

drop policy if exists menu_categories_admin_read on public.menu_categories;
create policy menu_categories_admin_read
on public.menu_categories
for select
to authenticated
using(private.can_read_menu(menu_id));

drop policy if exists menu_dishes_admin_read on public.menu_dishes;
create policy menu_dishes_admin_read
on public.menu_dishes
for select
to authenticated
using(private.can_read_menu(menu_id));

drop policy if exists menu_promotions_admin_read on public.menu_promotions;
create policy menu_promotions_admin_read
on public.menu_promotions
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and (
    (venue_id is null and private.can_manage_shared_catalog())
    or (venue_id is not null and private.has_venue(venue_id))
  )
);

create or replace function private.validate_menu_dish()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if not exists(
    select 1
    from public.dishes d
    join public.menu_categories mc
      on mc.menu_id=new.menu_id
     and mc.category_id=d.category_id
    where d.id=new.dish_id
  ) then
    raise exception 'MENU_CATEGORY_REQUIRED';
  end if;
  return new;
end
$$;

drop trigger if exists menu_dish_valid on public.menu_dishes;
create trigger menu_dish_valid
before insert or update on public.menu_dishes
for each row execute function private.validate_menu_dish();

create or replace function private.validate_menu_promotion()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.menu_id is not null
     and new.venue_id is not null
     and not exists(
       select 1
       from public.menu_venues mv
       where mv.menu_id=new.menu_id
         and mv.venue_id=new.venue_id
     )
  then
    raise exception 'MENU_VENUE_REQUIRED';
  end if;
  return new;
end
$$;

drop trigger if exists menu_promotion_valid on public.menu_promotions;
create trigger menu_promotion_valid
before insert or update on public.menu_promotions
for each row execute function private.validate_menu_promotion();

drop trigger if exists touch_version on public.menus;
create trigger touch_version
before update on public.menus
for each row execute function private.touch_version();

drop trigger if exists touch_version on public.menu_promotions;
create trigger touch_version
before update on public.menu_promotions
for each row execute function private.touch_version();

drop trigger if exists audit_mutation on public.menus;
create trigger audit_mutation
after insert or update or delete on public.menus
for each row execute function private.audit_row();

drop trigger if exists audit_mutation on public.menu_venues;
create trigger audit_mutation
after insert or update or delete on public.menu_venues
for each row execute function private.audit_row();

drop trigger if exists audit_mutation on public.menu_categories;
create trigger audit_mutation
after insert or update or delete on public.menu_categories
for each row execute function private.audit_row();

drop trigger if exists audit_mutation on public.menu_dishes;
create trigger audit_mutation
after insert or update or delete on public.menu_dishes
for each row execute function private.audit_row();

drop trigger if exists audit_mutation on public.menu_promotions;
create trigger audit_mutation
after insert or update or delete on public.menu_promotions
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
