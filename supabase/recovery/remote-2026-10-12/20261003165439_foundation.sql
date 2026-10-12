-- Plateform: one customer per database. All application mutations use reviewed RPCs.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
-- Schema-local revokes cannot remove PostgreSQL's global default PUBLIC EXECUTE.
alter default privileges revoke execute on functions from public;

create type public.user_role as enum ('SUPER_ADMIN','ADMIN','HOST','CASHIER','KITCHEN_ADMIN','KITCHEN_STAFF','PASS','WAITER','CUSTOMER','SYSTEM');
create type public.user_scope as enum ('CHAIN','VENUE');
create type public.installation_status as enum ('ACTIVE','SUSPENDED','PENDING_DELETION','ARCHIVED','PERMANENTLY_DELETED');
create type public.reservation_status as enum ('REQUESTED','RESERVED','ARRIVED','SEATED','COMPLETED','NO_SHOW','CANCELLED');
create type public.table_status as enum ('AVAILABLE','RESERVED','ARRIVING','OCCUPIED','ORDERING','WAITING_SERVICE','WAITING_BILL','PAYMENT','TO_RESET');
create type public.account_status as enum ('OPEN','BILL_REQUESTED','AT_CASHIER','PARTIALLY_PAID','PAID','CLOSED');
create type public.order_status as enum ('RECEIVED','IN_PREPARATION','READY','SERVED','CANCELLED');
create type public.step_status as enum ('WAITING','ACTIVE','READY','SERVED','CANCELLED');
create type public.payment_status as enum ('PENDING','COMPLETED','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED');
create type public.refund_status as enum ('REQUESTED','APPROVED','PENDING','COMPLETED','FAILED','REJECTED');
create type public.print_job_status as enum ('QUEUED','SENT','SUCCESS','FAILED','CANCELLED');
create type public.sync_status as enum ('PENDING','SYNCING','SYNCED','CONFLICT','REJECTED','RESOLVED');
create type public.incident_severity as enum ('INFO','WARNING','DEGRADED','INCIDENT','CRITICAL');
create type public.notification_status as enum ('NEW','ACKNOWLEDGED','RESOLVED','EXPIRED');
create type public.payment_method as enum ('CASH','CARD_POS','STRIPE','SATISPAY_POS','SATISPAY_API');

create table public.restaurant_profile (
  id boolean primary key default true check(id),
  name text not null check(length(name) between 1 and 160),
  legal_name text, public_base_url text not null, staff_base_url text not null,
  staff_identity_domain text not null,
  status public.installation_status not null default 'ACTIVE',
  branding jsonb not null default '{}', public_content jsonb not null default '{}',
  contact jsonb not null default '{}', version bigint not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(public_base_url <> staff_base_url)
);
create table public.restaurant_settings (
  id boolean primary key default true references public.restaurant_profile(id) check(id),
  admin_mfa_required boolean not null default true,
  cashier_mfa_required boolean not null default false,
  full_auth_minutes integer not null default 120 check(full_auth_minutes between 30 and 720),
  offline_ttl_minutes integer not null default 30 check(offline_ttl_minutes between 5 and 120),
  retention jsonb not null default '{"reservation_days":180,"customer_session_days":30,"telemetry_days":30}',
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.system_limits (
  id boolean primary key default true references public.restaurant_profile(id) check(id),
  max_users integer not null default 100 check(max_users > 0),
  max_venues integer not null default 10 check(max_venues > 0),
  max_tables_per_venue integer not null default 200 check(max_tables_per_venue > 0),
  max_dishes integer not null default 1000 check(max_dishes > 0),
  max_devices integer not null default 100 check(max_devices > 0),
  max_storage_bytes bigint not null default 10737418240 check(max_storage_bytes > 0)
);
create table public.feature_flags (
  name text primary key check(name in ('MULTI_VENUE','CLIENT_ORDERING','STRIPE','SATISPAY_API','OFFLINE','ADVANCED_ROOM_EDITOR','ADVANCED_ANALYTICS')),
  licensed boolean not null default false, updated_at timestamptz not null default now(),
  version bigint not null default 1
);
insert into public.feature_flags(name) values ('MULTI_VENUE'),('CLIENT_ORDERING'),('STRIPE'),('SATISPAY_API'),('OFFLINE'),('ADVANCED_ROOM_EDITOR'),('ADVANCED_ANALYTICS');

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  profile_id boolean not null default true references public.restaurant_profile(id) check(profile_id),
  name text not null check(length(name) between 1 and 160),
  slug text not null unique check(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  code text not null unique, address text not null, phone text not null,
  email text, opening_hours jsonb not null default '{}',
  timezone text not null default 'Europe/Rome', currency text not null default 'EUR' check(currency ~ '^[A-Z]{3}$'),
  locale text not null default 'it-IT', active boolean not null default true,
  operational_status text not null default 'OPEN' check(operational_status in ('OPEN','CLOSED','MAINTENANCE')),
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.venue_settings (
  venue_id uuid primary key references public.venues(id),
  reservations_enabled boolean not null default false,
  customer_ordering text not null default 'WAITER_APPROVAL' check(customer_ordering in ('DISABLED','WAITER_APPROVAL','DIRECT')),
  customer_bill_request boolean not null default false, returns_enabled boolean not null default false,
  step_starter_roles public.user_role[] not null default array['WAITER','PASS','KITCHEN_ADMIN']::public.user_role[],
  delivery_routing text[] not null default array['TABLE','ZONE'],
  enabled_features text[] not null default '{}',
  payment_methods public.payment_method[] not null default array['CASH','CARD_POS']::public.payment_method[],
  discount_policy text not null default 'ADMIN_APPROVAL_REQUIRED' check(discount_policy in ('DISABLED','ADMIN_APPROVAL_REQUIRED','CASHIER_AUTONOMOUS')),
  complimentary_policy text not null default 'ADMIN_APPROVAL_REQUIRED' check(complimentary_policy in ('DISABLED','ADMIN_APPROVAL_REQUIRED','CASHIER_AUTONOMOUS')),
  sounds jsonb not null default '{}', version bigint not null default 1, updated_at timestamptz not null default now()
);

create table public.staff_profiles (
  id uuid primary key references auth.users(id),
  display_name text not null check(length(display_name) between 1 and 160),
  role public.user_role not null check(role not in ('CUSTOMER','SYSTEM')),
  scope public.user_scope not null, active boolean not null default true,
  auth_valid_after timestamptz not null default '-infinity',
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(role <> 'SUPER_ADMIN' or scope = 'CHAIN')
);
create table public.staff_venue_assignments (
  user_id uuid not null references public.staff_profiles(id), venue_id uuid not null references public.venues(id),
  active boolean not null default true, primary key(user_id, venue_id)
);
create index staff_venue_scope on public.staff_venue_assignments(venue_id,user_id) where active;
create table public.shifts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id),
  staff_id uuid not null references public.staff_profiles(id), starts_at timestamptz not null,
  ends_at timestamptz not null, check(ends_at > starts_at), version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.registered_devices (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.staff_profiles(id),
  venue_id uuid not null references public.venues(id), display_name text not null,
  platform text not null, assigned_role_or_station text,
  last_seen_at timestamptz not null default now(), app_version text not null,
  last_sync_at timestamptz, revoked_at timestamptz, unique(venue_id,id)
);
create table private.staff_pins (
  user_id uuid primary key references public.staff_profiles(id), pin_hash text not null,
  failed_attempts integer not null default 0, locked_until timestamptz, updated_at timestamptz not null default now()
);
create table private.staff_sessions (
  session_id uuid primary key, user_id uuid not null references public.staff_profiles(id),
  device_id uuid references public.registered_devices(id),
  full_auth_at timestamptz not null, unlocked_until timestamptz not null,
  revoked_at timestamptz, created_at timestamptz not null default now()
);
create table private.step_up_grants (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.staff_profiles(id),
  session_id uuid not null, action text not null, resource_id uuid,
  expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now()
);
create table private.impersonation_sessions (
  id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.staff_profiles(id),
  subject_id uuid not null references public.staff_profiles(id), session_id uuid not null,
  write_enabled boolean not null default false, reason text not null check(length(reason) >= 8),
  expires_at timestamptz not null, ended_at timestamptz, created_at timestamptz not null default now(),
  check(actor_id <> subject_id)
);
create table private.rate_limits (
  bucket text primary key, attempts integer not null default 0,
  window_started_at timestamptz not null default now(), blocked_until timestamptz
);
create table private.idempotency_keys (
  actor_id uuid not null, operation text not null, key uuid not null,
  payload_hash text not null, response jsonb, created_at timestamptz not null default now(),
  primary key(actor_id,operation,key)
);

-- The deferred invariant allows initial profile + venue creation in one transaction.
create function private.enforce_venue_invariant() returns trigger language plpgsql security definer set search_path='' as $$
declare n integer; multi boolean;
begin
  perform 1 from public.restaurant_profile where id for update;
  select count(*) into n from public.venues where active;
  select licensed into multi from public.feature_flags where name='MULTI_VENUE';
  if n > 1 and not coalesce(multi,false) then raise exception 'MULTI_VENUE_DISABLED' using errcode='23514'; end if;
  if n > (select max_venues from public.system_limits where id) then raise exception 'VENUE_LIMIT' using errcode='23514'; end if;
  if n = 0 and exists(select 1 from public.restaurant_profile where status='ACTIVE') then raise exception 'FIRST_VENUE_REQUIRED' using errcode='23514'; end if;
  return null;
end $$;
create constraint trigger venue_invariant after insert or update or delete on public.venues deferrable initially deferred for each row execute function private.enforce_venue_invariant();
create constraint trigger feature_venue_invariant after update on public.feature_flags deferrable initially deferred for each row execute function private.enforce_venue_invariant();
create constraint trigger profile_venue_invariant after insert or update on public.restaurant_profile deferrable initially deferred for each row execute function private.enforce_venue_invariant();

create function private.touch_version() returns trigger language plpgsql set search_path='' as $$
begin new.version := old.version + 1; new.updated_at := now(); return new; end $$;

create function private.jwt_session_id() returns uuid language sql stable set search_path='' as $$
  select nullif(auth.jwt()->>'session_id','')::uuid
$$;
create function private.real_role() returns public.user_role language sql stable security definer set search_path='' as $$
  select p.role from public.staff_profiles p where p.id=auth.uid() and p.active
    and to_timestamp(coalesce((auth.jwt()->>'iat')::double precision,0)) >= p.auth_valid_after
    and (p.role <> 'SUPER_ADMIN' or auth.jwt()->>'aal' = 'aal2')
    and (p.role <> 'ADMIN' or not coalesce((select admin_mfa_required from public.restaurant_settings where id),true) or auth.jwt()->>'aal'='aal2')
    and (p.role <> 'CASHIER' or not coalesce((select cashier_mfa_required from public.restaurant_settings where id),false) or auth.jwt()->>'aal'='aal2')
$$;
create function private.impersonation_id() returns uuid language sql stable set search_path='' as $$
  select nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-plateform-impersonation','')::uuid
$$;
create function private.effective_user_id() returns uuid language plpgsql stable security definer set search_path='' as $$
declare target uuid;
begin
  if private.real_role() is null then return null; end if;
  if private.impersonation_id() is null then return auth.uid(); end if;
  if private.real_role() <> 'SUPER_ADMIN' then return null; end if;
  select i.subject_id into target from private.impersonation_sessions i join public.staff_profiles p on p.id=i.subject_id
   where i.id=private.impersonation_id() and i.actor_id=auth.uid() and i.session_id=private.jwt_session_id()
     and i.ended_at is null and i.expires_at > now() and p.active;
  return target;
end $$;
create function private.current_role() returns public.user_role language sql stable security definer set search_path='' as $$
  select role from public.staff_profiles where id=private.effective_user_id() and active
$$;
create function private.installation_active() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.restaurant_profile where id and status='ACTIVE')
$$;
create function private.has_venue(p_venue uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.staff_profiles p join public.venues v on v.id=p_venue and v.active
    where p.id=private.effective_user_id() and p.active and private.installation_active()
    and (p.scope='CHAIN' or exists(select 1 from public.staff_venue_assignments a where a.user_id=p.id and a.venue_id=v.id and a.active)))
$$;
create function private.is_role(p_roles public.user_role[]) returns boolean language sql stable set search_path='' as $$
  select coalesce(private.current_role()=any(p_roles),false)
$$;
create function private.authorize(p_venue uuid,p_roles public.user_role[],p_write boolean default true) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid := private.effective_user_id();
begin
  if actor is null or not private.is_role(p_roles) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_venue is not null and not private.has_venue(p_venue) then raise exception 'VENUE_FORBIDDEN' using errcode='42501'; end if;
  if p_venue is null and private.current_role()<>'SUPER_ADMIN' and not private.installation_active() then raise exception 'INSTALLATION_SUSPENDED' using errcode='42501'; end if;
  if p_write and private.impersonation_id() is not null and not exists(select 1 from private.impersonation_sessions where id=private.impersonation_id() and write_enabled) then raise exception 'IMPERSONATION_READ_ONLY' using errcode='42501'; end if;
  return actor;
end $$;
create function private.consume_step_up(p_id uuid,p_action text,p_resource uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
  update private.step_up_grants set consumed_at=now() where id=p_id and user_id=auth.uid()
    and session_id=private.jwt_session_id() and action=p_action and resource_id is not distinct from p_resource
    and expires_at>now() and consumed_at is null;
  if not found then raise exception 'STEP_UP_REQUIRED' using errcode='42501'; end if;
end $$;

-- Session-dependent helpers are callable for policies but not exposed as API RPCs.
grant execute on function private.real_role(),private.effective_user_id(),private.current_role(),private.installation_active(),private.has_venue(uuid),private.is_role(public.user_role[]) to authenticated;
commit;
