begin;
create table public.rooms (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  name text not null, active boolean not null default true, unique(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.room_layouts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), room_id uuid not null,
  name text not null, active boolean not null default false, archived boolean not null default false,
  width integer not null default 1200 check(width between 100 and 20000), height integer not null default 800 check(height between 100 and 20000),
  elements jsonb not null default '[]' check(jsonb_typeof(elements)='array'),
  unique(venue_id,id), unique(venue_id,room_id,id), foreign key(venue_id,room_id) references public.rooms(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create unique index one_active_layout on public.room_layouts(room_id) where active and not archived;
create table public.zones (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), room_id uuid not null,
  name text not null, color text not null default '#B88A55', active boolean not null default true,
  unique(venue_id,id), foreign key(venue_id,room_id) references public.rooms(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.tables (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), room_id uuid not null,
  layout_id uuid not null, zone_id uuid, public_table_id uuid not null unique default gen_random_uuid(),
  number integer not null check(number>0), name text not null, seats integer not null check(seats between 1 and 1000),
  technical_status public.table_status not null default 'AVAILABLE', shape text not null default 'ROUND' check(shape in ('ROUND','SQUARE','RECTANGLE','OVAL')),
  position_x numeric not null default 0, position_y numeric not null default 0,
  width numeric not null default 80 check(width>0), height numeric not null default 80 check(height>0), rotation numeric not null default 0,
  active boolean not null default true, unique(venue_id,id), unique(layout_id,number),
  foreign key(venue_id,room_id,layout_id) references public.room_layouts(venue_id,room_id,id),
  foreign key(venue_id,zone_id) references public.zones(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.table_status_definitions (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  technical_status public.table_status not null, label text not null, color text not null, icon text, sort_order integer not null default 0,
  unique(venue_id,technical_status)
);
create table public.stations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  name text not null, active boolean not null default true, unique(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.table_assignments (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  waiter_id uuid not null references public.staff_profiles(id), mode text not null check(mode in ('TABLE','ZONE','RUNNER')),
  table_id uuid, zone_id uuid, active boolean not null default true,
  foreign key(venue_id,table_id) references public.tables(venue_id,id), foreign key(venue_id,zone_id) references public.zones(venue_id,id),
  check((mode='TABLE' and table_id is not null and zone_id is null) or (mode='ZONE' and zone_id is not null and table_id is null) or (mode='RUNNER' and table_id is null and zone_id is null))
);
create unique index one_table_waiter on public.table_assignments(table_id) where active and mode='TABLE';
create unique index one_zone_waiter on public.table_assignments(zone_id) where active and mode='ZONE';
create table public.station_staff_assignments (
  venue_id uuid not null references public.venues(id), station_id uuid not null, user_id uuid not null references public.staff_profiles(id),
  active boolean not null default true, primary key(station_id,user_id), foreign key(venue_id,station_id) references public.stations(venue_id,id)
);
create table public.table_merges (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  primary_table_id uuid not null, secondary_table_id uuid not null,
  merged_at timestamptz not null default now(), split_at timestamptz,
  foreign key(venue_id,primary_table_id) references public.tables(venue_id,id), foreign key(venue_id,secondary_table_id) references public.tables(venue_id,id),
  check(primary_table_id<>secondary_table_id)
);
create unique index one_merge_membership on public.table_merges(secondary_table_id) where split_at is null;

create table public.services (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  name text not null, starts_at time not null, ends_at time not null,
  weekdays integer[] not null default array[1,2,3,4,5,6,7], active boolean not null default true,
  unique(venue_id,id), check(weekdays <@ array[1,2,3,4,5,6,7]),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.service_booking_rules (
  venue_id uuid not null references public.venues(id), service_id uuid primary key,
  max_covers_service integer not null check(max_covers_service>0), slot_interval_minutes integer not null default 30 check(slot_interval_minutes between 5 and 180),
  max_arrivals_per_slot integer not null check(max_arrivals_per_slot>0), max_covers_per_slot integer not null check(max_covers_per_slot>0),
  max_party_size_auto_confirm integer not null default 8 check(max_party_size_auto_confirm>0),
  large_party_mode text not null default 'REQUESTED' check(large_party_mode in ('REQUESTED','REJECT')),
  foreign key(venue_id,service_id) references public.services(venue_id,id)
);
create table public.booking_time_slots (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), service_id uuid not null,
  service_date date not null, slot_time time, closed boolean not null default false,
  max_covers_override integer check(max_covers_override>=0), max_arrivals_override integer check(max_arrivals_override>=0),
  reason text, foreign key(venue_id,service_id) references public.services(venue_id,id)
);
create unique index unique_booking_slot on public.booking_time_slots(service_id,service_date,slot_time) nulls not distinct;
create table public.reservation_form_definitions (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  name text not null, active boolean not null default true, unique(venue_id,id), version bigint not null default 1, updated_at timestamptz not null default now()
);
create unique index one_active_booking_form on public.reservation_form_definitions(venue_id) where active;
create table public.reservation_form_fields (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), form_id uuid not null,
  key text not null, type text not null check(type in ('text','textarea','number','tel','date','time','select','radio','checkbox')),
  label text not null, placeholder text, required boolean not null default false, sort_order integer not null default 0,
  options jsonb not null default '[]', visible boolean not null default true,
  foreign key(venue_id,form_id) references public.reservation_form_definitions(venue_id,id), unique(form_id,key), unique(venue_id,id)
);
create table public.reservations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), service_id uuid not null,
  service_date date not null, slot_time time not null, first_name text not null, last_name text not null default '',
  phone text not null, party_size integer not null check(party_size between 1 and 1000),
  status public.reservation_status not null, internal_note text, customer_note text, allergies text,
  table_id uuid, walk_in boolean not null default false,
  created_at timestamptz not null default now(), arrived_at timestamptz, seated_at timestamptz, completed_at timestamptz,
  unique(venue_id,id), foreign key(venue_id,service_id) references public.services(venue_id,id), foreign key(venue_id,table_id) references public.tables(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create index booking_pacing on public.reservations(service_id,service_date,slot_time,status);
create unique index booking_duplicate on public.reservations(venue_id,service_id,service_date,slot_time,phone) where status not in ('CANCELLED','NO_SHOW') and not walk_in;
create table public.reservation_answers (
  venue_id uuid not null references public.venues(id), reservation_id uuid not null, field_id uuid not null, answer jsonb not null,
  primary key(reservation_id,field_id), foreign key(venue_id,reservation_id) references public.reservations(venue_id,id),
  foreign key(venue_id,field_id) references public.reservation_form_fields(venue_id,id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(), name text not null, description text,
  sort_order integer not null default 0, active boolean not null default true, version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.ingredients (id uuid primary key default gen_random_uuid(), name text not null unique, active boolean not null default true);
create table public.allergens (id uuid primary key default gen_random_uuid(), code text not null unique, name text not null);
create table public.ingredient_allergens (
  ingredient_id uuid not null references public.ingredients(id), allergen_id uuid not null references public.allergens(id), primary key(ingredient_id,allergen_id)
);
create table public.dishes (
  id uuid primary key default gen_random_uuid(), category_id uuid not null references public.categories(id),
  name text not null, description text not null default '', image_path text, beverage boolean not null default false,
  price_cents bigint not null check(price_cents between 0 and 100000000), active boolean not null default true,
  sort_order integer not null default 0, schedule_mode text not null default 'ALWAYS' check(schedule_mode in ('ALWAYS','DATE','WEEKDAYS','RANGE')),
  available_from date, available_until date, weekdays integer[] not null default '{}',
  version bigint not null default 1, updated_at timestamptz not null default now(),
  check(weekdays <@ array[1,2,3,4,5,6,7]),
  check(schedule_mode='ALWAYS' or (schedule_mode='DATE' and available_from is not null) or (schedule_mode='WEEKDAYS' and cardinality(weekdays)>0) or (schedule_mode='RANGE' and available_from is not null and available_until>=available_from))
);
create table public.dish_ingredients (
  dish_id uuid not null references public.dishes(id), ingredient_id uuid not null references public.ingredients(id),
  removable boolean not null default false, primary key(dish_id,ingredient_id)
);
create table public.dietary_tags (id uuid primary key default gen_random_uuid(), code text not null unique, label text not null);
create table public.dish_dietary_tags (dish_id uuid not null references public.dishes(id), tag_id uuid not null references public.dietary_tags(id), primary key(dish_id,tag_id));
create table public.variant_groups (
  id uuid primary key default gen_random_uuid(), dish_id uuid not null references public.dishes(id), name text not null,
  required boolean not null default false, max_selections integer not null default 1 check(max_selections between 1 and 20), active boolean not null default true,
  unique(dish_id,id)
);
create table public.variant_options (
  id uuid primary key default gen_random_uuid(), group_id uuid not null references public.variant_groups(id), label text not null,
  active boolean not null default true, unique(group_id,id)
);
create table public.venue_dish_settings (
  venue_id uuid not null references public.venues(id), dish_id uuid not null references public.dishes(id),
  enabled boolean not null default true, local_price_cents bigint check(local_price_cents between 0 and 100000000),
  availability integer check(availability>=0), availability_date date, local_station_id uuid,
  primary key(venue_id,dish_id), foreign key(venue_id,local_station_id) references public.stations(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.dish_station_assignments (
  venue_id uuid not null references public.venues(id), dish_id uuid not null references public.dishes(id), station_id uuid not null,
  is_primary boolean not null default false, primary key(venue_id,dish_id,station_id), foreign key(venue_id,station_id) references public.stations(venue_id,id)
);
create unique index one_primary_station on public.dish_station_assignments(venue_id,dish_id) where is_primary;

create table public.accounts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), table_id uuid not null,
  account_name text not null check(length(account_name) between 1 and 160), covers integer not null check(covers between 1 and 1000),
  internal_note text, status public.account_status not null default 'OPEN',
  created_by uuid not null references public.staff_profiles(id), created_at timestamptz not null default now(), closed_at timestamptz,
  access_epoch integer not null default 1, unique(venue_id,id), foreign key(venue_id,table_id) references public.tables(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create index active_table_accounts on public.accounts(table_id) where status<>'CLOSED';
create table private.customer_access_codes (
  account_id uuid primary key references public.accounts(id), code_hash text not null, lookup_hash text not null,
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
create table private.customer_sessions (
  id uuid primary key default gen_random_uuid(), account_id uuid not null references public.accounts(id),
  auth_user_id uuid not null references auth.users(id), table_id uuid not null references public.tables(id),
  access_epoch integer not null, expires_at timestamptz not null, revoked_at timestamptz,
  created_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
);
create index customer_session_lookup on private.customer_sessions(auth_user_id,account_id) where revoked_at is null;
create table public.orders (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null,
  status public.order_status not null default 'RECEIVED', origin text not null check(origin in ('WAITER','CUSTOMER','OFFLINE')),
  created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
  unique(venue_id,id), foreign key(venue_id,account_id) references public.accounts(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.order_steps (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), order_id uuid not null,
  step_number integer not null check(step_number between 1 and 99), status public.step_status not null default 'WAITING',
  started_at timestamptz, ready_at timestamptz, served_at timestamptz,
  unique(order_id,step_number), unique(venue_id,id), foreign key(venue_id,order_id) references public.orders(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), order_id uuid not null, step_id uuid not null,
  dish_id uuid not null references public.dishes(id), station_id uuid not null,
  quantity integer not null check(quantity between 1 and 999), unit_price_cents bigint not null check(unit_price_cents between 0 and 100000000),
  dish_name text not null, category_name text not null, ingredient_snapshot jsonb not null, allergen_snapshot jsonb not null,
  status public.order_status not null default 'RECEIVED', started_at timestamptz, ready_at timestamptz, served_at timestamptz,
  unique(venue_id,id), foreign key(venue_id,order_id) references public.orders(venue_id,id),
  foreign key(venue_id,step_id) references public.order_steps(venue_id,id), foreign key(venue_id,station_id) references public.stations(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create index kitchen_items on public.order_items(venue_id,station_id,status,order_id);
create table public.order_item_removed_ingredients (
  venue_id uuid not null references public.venues(id), order_item_id uuid not null, ingredient_id uuid not null references public.ingredients(id),
  ingredient_name text not null, primary key(order_item_id,ingredient_id), foreign key(venue_id,order_item_id) references public.order_items(venue_id,id)
);
create table public.order_item_variants (
  venue_id uuid not null references public.venues(id), order_item_id uuid not null, option_id uuid not null references public.variant_options(id),
  group_name text not null, option_name text not null, primary key(order_item_id,option_id), foreign key(venue_id,order_item_id) references public.order_items(venue_id,id)
);
create table public.customer_order_requests (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null,
  requested_by uuid not null references auth.users(id), payload jsonb not null,
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
  order_id uuid, reason text, created_at timestamptz not null default now(), resolved_at timestamptz,
  foreign key(venue_id,account_id) references public.accounts(venue_id,id), foreign key(venue_id,order_id) references public.orders(venue_id,id), unique(venue_id,id)
);
create table public.order_change_requests (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), order_id uuid not null,
  requested_by uuid not null references public.staff_profiles(id), kind text not null check(kind in ('MODIFICATION','CANCELLATION','RETURN_CANCELLATION')),
  payload jsonb not null, reason text not null, status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED')),
  resolved_by uuid references public.staff_profiles(id), created_at timestamptz not null default now(), resolved_at timestamptz,
  foreign key(venue_id,order_id) references public.orders(venue_id,id), unique(venue_id,id)
);
create table public.returned_items (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), order_item_id uuid not null,
  reason text not null default 'ERRORE ORDINE' check(reason='ERRORE ORDINE'),
  action text not null check(action in ('REMAKE','CANCEL_REQUEST')), created_at timestamptz not null default now(),
  foreign key(venue_id,order_item_id) references public.order_items(venue_id,id)
);
create table public.waiter_calls (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null, table_id uuid not null,
  assigned_waiter_id uuid references public.staff_profiles(id), kind text not null default 'WAITER' check(kind in ('WAITER','BILL')),
  status text not null default 'NEW' check(status in ('NEW','ACCEPTED','COMPLETED')),
  created_at timestamptz not null default now(), accepted_at timestamptz, completed_at timestamptz,
  foreign key(venue_id,account_id) references public.accounts(venue_id,id), foreign key(venue_id,table_id) references public.tables(venue_id,id), unique(venue_id,id)
);
create unique index one_pending_call on public.waiter_calls(account_id,kind) where status<>'COMPLETED';
create table public.notifications (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  recipient_user_id uuid references public.staff_profiles(id), recipient_role public.user_role,
  category text not null, priority public.incident_severity not null default 'INFO',
  status public.notification_status not null default 'NEW', title text not null,
  created_at timestamptz not null default now(), acknowledged_at timestamptz, resolved_at timestamptz, expires_at timestamptz,
  resource_type text not null, resource_id uuid not null, check(recipient_user_id is not null or recipient_role is not null),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create index notification_inbox on public.notifications(recipient_user_id,status,created_at desc);
commit;
