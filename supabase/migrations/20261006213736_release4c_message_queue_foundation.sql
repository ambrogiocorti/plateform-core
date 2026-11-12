
create table if not exists public.message_provider_settings(
  venue_id uuid not null references public.venues(id),
  channel text not null check(channel in ('WHATSAPP','SMS','TELEGRAM')),
  adapter text not null check(adapter in ('TWILIO','TELEGRAM','MOCK')),
  enabled boolean not null default false,
  sender_ref text,
  confirmation_template text,
  reminder_template text,
  max_attempts integer not null default 5 check(max_attempts between 1 and 10),
  base_backoff_seconds integer not null default 30 check(base_backoff_seconds between 5 and 3600),
  max_backoff_seconds integer not null default 1800 check(max_backoff_seconds between 30 and 21600),
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(venue_id,channel),
  check(sender_ref is null or length(trim(sender_ref)) between 1 and 200),
  check(confirmation_template is null or length(trim(confirmation_template)) between 1 and 160),
  check(reminder_template is null or length(trim(reminder_template)) between 1 and 160),
  check(max_backoff_seconds>=base_backoff_seconds),
  check(
    (channel='TELEGRAM' and adapter in ('TELEGRAM','MOCK'))
    or (channel in ('WHATSAPP','SMS') and adapter in ('TWILIO','MOCK'))
  )
);

create table if not exists public.reservation_reminder_rules(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  channel text not null check(channel in ('WHATSAPP','SMS','TELEGRAM')),
  offset_minutes integer not null check(offset_minutes between 15 and 20160),
  template_key text,
  active boolean not null default true,
  version bigint not null default 1,
  updated_at timestamptz not null default clock_timestamp(),
  unique(venue_id,channel,offset_minutes),
  check(template_key is null or length(trim(template_key)) between 1 and 160)
);

create table if not exists public.message_jobs(
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  reservation_id uuid references public.reservations(id),
  event_type text not null
    check(event_type in ('RESERVATION_CONFIRMATION','RESERVATION_REMINDER')),
  channel text not null check(channel in ('WHATSAPP','SMS','TELEGRAM')),
  adapter text not null check(adapter in ('TWILIO','TELEGRAM','MOCK')),
  dedupe_key text not null unique check(length(dedupe_key) between 16 and 240),
  state text not null default 'QUEUED'
    check(state in ('QUEUED','SENDING','SENT','DELIVERED','FAILED','CANCELLED')),
  scheduled_for timestamptz not null,
  next_attempt_at timestamptz not null,
  attempts integer not null default 0 check(attempts>=0),
  max_attempts integer not null check(max_attempts between 1 and 10),
  lease_token uuid,
  lease_until timestamptz,
  provider_message_id text,
  last_error_code text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(next_attempt_at>=scheduled_for or attempts>0),
  check(provider_message_id is null or length(provider_message_id) between 1 and 240),
  check(last_error_code is null or length(last_error_code) between 1 and 120),
  check((lease_token is null)=(lease_until is null))
);

create table if not exists private.message_job_payloads(
  job_id uuid primary key references public.message_jobs(id) on delete cascade,
  destination text not null check(length(destination) between 2 and 240),
  locale text not null default 'it-IT' check(length(locale) between 2 and 16),
  template_key text not null check(length(template_key) between 1 and 160),
  template_data jsonb not null default '{}'::jsonb check(jsonb_typeof(template_data)='object'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists private.message_provider_events(
  adapter text not null,
  event_id text not null,
  job_id uuid not null references public.message_jobs(id),
  state text not null check(state in ('SENT','DELIVERED','FAILED')),
  created_at timestamptz not null default clock_timestamp(),
  primary key(adapter,event_id),
  check(length(event_id) between 1 and 240)
);

alter table public.message_provider_settings enable row level security;
alter table public.reservation_reminder_rules enable row level security;
alter table public.message_jobs enable row level security;
alter table private.message_job_payloads enable row level security;
alter table private.message_provider_events enable row level security;

revoke all on table public.message_provider_settings from anon,authenticated;
revoke all on table public.reservation_reminder_rules from anon,authenticated;
revoke all on table public.message_jobs from anon,authenticated;
revoke all on table private.message_job_payloads from public,anon,authenticated;
revoke all on table private.message_provider_events from public,anon,authenticated;

grant select on table public.message_provider_settings to authenticated;
grant select on table public.reservation_reminder_rules to authenticated;
grant select on table public.message_jobs to authenticated;

create policy message_provider_settings_admin_read
on public.message_provider_settings
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN']::public.user_role[])
  and private.has_venue(venue_id)
);

create policy reservation_reminder_rules_staff_read
on public.reservation_reminder_rules
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','HOST']::public.user_role[])
  and private.has_venue(venue_id)
);

create policy message_jobs_staff_read
on public.message_jobs
for select
to authenticated
using(
  private.installation_active()
  and private.is_role(array['ADMIN','HOST']::public.user_role[])
  and private.has_venue(venue_id)
);

create index if not exists message_provider_settings_adapter_idx
on public.message_provider_settings(adapter,enabled,venue_id);

create index if not exists reservation_reminder_rules_due_idx
on public.reservation_reminder_rules(venue_id,active,offset_minutes,channel);

create index if not exists reservation_reminder_rules_channel_idx
on public.reservation_reminder_rules(channel,venue_id);

create index if not exists message_jobs_due_idx
on public.message_jobs(state,next_attempt_at,scheduled_for)
where state in ('QUEUED','FAILED');

create index if not exists message_jobs_reservation_idx
on public.message_jobs(reservation_id,created_at desc)
where reservation_id is not null;

create index if not exists message_jobs_venue_idx
on public.message_jobs(venue_id,created_at desc);

create index if not exists message_provider_events_job_idx
on private.message_provider_events(job_id,created_at desc);

create or replace function private.guard_message_job()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE' or tg_op='TRUNCATE' then
    raise exception 'IMMUTABLE_MESSAGE_JOB';
  end if;

  if (
    to_jsonb(new)
      - array[
        'state','next_attempt_at','attempts','lease_token','lease_until',
        'provider_message_id','last_error_code','sent_at','delivered_at',
        'failed_at','cancelled_at','version','updated_at'
      ]
  ) is distinct from (
    to_jsonb(old)
      - array[
        'state','next_attempt_at','attempts','lease_token','lease_until',
        'provider_message_id','last_error_code','sent_at','delivered_at',
        'failed_at','cancelled_at','version','updated_at'
      ]
  ) then
    raise exception 'IMMUTABLE_MESSAGE_JOB';
  end if;

  if old.state='DELIVERED' and new.state<>old.state then
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if old.state='CANCELLED' and new.state<>old.state then
    raise exception 'MESSAGE_TERMINAL';
  end if;

  if old.state='QUEUED' and new.state not in ('QUEUED','SENDING','FAILED','CANCELLED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENDING' and new.state not in ('SENDING','QUEUED','SENT','FAILED','CANCELLED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='SENT' and new.state not in ('SENT','DELIVERED','FAILED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  elsif old.state='FAILED' and new.state not in ('FAILED','QUEUED','SENDING','CANCELLED') then
    raise exception 'INVALID_MESSAGE_TRANSITION';
  end if;

  if new.attempts>new.max_attempts then
    raise exception 'MESSAGE_ATTEMPT_LIMIT';
  end if;

  if new.state='SENDING' and (new.lease_token is null or new.lease_until is null) then
    raise exception 'MESSAGE_LEASE_REQUIRED';
  end if;

  if new.state<>'SENDING' and new.lease_token is not null then
    raise exception 'MESSAGE_LEASE_FORBIDDEN';
  end if;

  return new;
end
$$;

create trigger message_job_guard
before update or delete on public.message_jobs
for each row execute function private.guard_message_job();

create trigger touch_version
before update on public.message_jobs
for each row execute function private.touch_version();

create trigger touch_version
before update on public.message_provider_settings
for each row execute function private.touch_version();

create trigger touch_version
before update on public.reservation_reminder_rules
for each row execute function private.touch_version();

create trigger audit_mutation
after insert or update on public.message_jobs
for each row execute function private.audit_row();

create trigger audit_mutation
after insert or update or delete on public.message_provider_settings
for each row execute function private.audit_row();

create trigger audit_mutation
after insert or update or delete on public.reservation_reminder_rules
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
