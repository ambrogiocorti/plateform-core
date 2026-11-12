begin;
create table public.print_devices (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), name text not null,
  driver text not null check(driver in ('BROWSER','EPOS','BRIDGE')), endpoint text, active boolean not null default true,
  allowed_roles public.user_role[] not null default array['CASHIER']::public.user_role[],
  configuration jsonb not null default '{}', unique(venue_id,id)
);
create table public.cash_registers (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), name text not null, code text not null,
  location text, status text not null default 'CLOSED' check(status in ('OPEN','CLOSED')), active boolean not null default true,
  printer_id uuid, payment_methods public.payment_method[] not null default array['CASH','CARD_POS']::public.payment_method[],
  configuration jsonb not null default '{}', unique(venue_id,id), unique(venue_id,code),
  foreign key(venue_id,printer_id) references public.print_devices(venue_id,id), version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.cashier_assignments (
  venue_id uuid not null references public.venues(id), cash_register_id uuid not null, user_id uuid not null references public.staff_profiles(id),
  active boolean not null default true, primary key(cash_register_id,user_id), foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id)
);
create table public.service_sessions (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), service_id uuid,
  status text not null default 'OPEN' check(status in ('OPEN','RECONCILING','AWAITING_APPROVAL','CLOSED')),
  opened_by uuid not null references public.staff_profiles(id), opened_at timestamptz not null default now(), closed_at timestamptz,
  unique(venue_id,id), foreign key(venue_id,service_id) references public.services(venue_id,id), version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.cash_register_sessions (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), cash_register_id uuid not null, service_session_id uuid not null,
  opening_float_cents bigint not null check(opening_float_cents between 0 and 1000000000),
  opened_at timestamptz not null default now(), closed_at timestamptz,
  unique(cash_register_id,service_session_id), unique(venue_id,id),
  foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id), foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id)
);
create unique index one_open_register_service on public.cash_register_sessions(cash_register_id) where closed_at is null;
create table public.payments (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null,
  cash_register_id uuid not null, service_session_id uuid not null, operator_user_id uuid not null references public.staff_profiles(id),
  method public.payment_method not null, status public.payment_status not null default 'PENDING',
  amount_cents bigint not null check(amount_cents between 1 and 100000000000), tip_cents bigint not null default 0 check(tip_cents between 0 and 10000000000),
  currency text not null check(currency ~ '^[A-Z]{3}$'), provider_id text unique, idempotency_key uuid not null unique,
  created_at timestamptz not null default now(), completed_at timestamptz,
  unique(venue_id,id), foreign key(venue_id,account_id) references public.accounts(venue_id,id),
  foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id), foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create index payments_account on public.payments(account_id,status);
create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), payment_id uuid not null, order_item_id uuid not null,
  quantity integer not null check(quantity>0), amount_cents bigint not null check(amount_cents>=0),
  foreign key(venue_id,payment_id) references public.payments(venue_id,id), foreign key(venue_id,order_item_id) references public.order_items(venue_id,id), unique(payment_id,order_item_id)
);
create table public.tips (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), payment_id uuid not null unique,
  amount_cents bigint not null check(amount_cents>0), foreign key(venue_id,payment_id) references public.payments(venue_id,id)
);
create table public.refunds (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), original_payment_id uuid not null,
  amount_cents bigint not null check(amount_cents>0), tip_cents bigint not null default 0 check(tip_cents>=0), method public.payment_method not null,
  authorized_by uuid not null references public.staff_profiles(id), status public.refund_status not null default 'APPROVED', reason text not null check(length(reason)>=3),
  provider_id text unique, idempotency_key uuid not null unique, created_at timestamptz not null default now(), completed_at timestamptz,
  foreign key(venue_id,original_payment_id) references public.payments(venue_id,id), unique(venue_id,id), version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.discounts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), account_id uuid not null, order_item_id uuid,
  kind text not null check(kind in ('FIXED','PERCENT','ITEM_COMPLIMENTARY','ACCOUNT_COMPLIMENTARY')),
  amount_cents bigint not null check(amount_cents>=0), percentage_basis_points integer check(percentage_basis_points between 0 and 10000),
  reason text not null, authorized_by uuid not null references public.staff_profiles(id), created_at timestamptz not null default now(),
  foreign key(venue_id,account_id) references public.accounts(venue_id,id), foreign key(venue_id,order_item_id) references public.order_items(venue_id,id)
);
create table public.account_splits (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), source_account_id uuid not null, target_account_id uuid,
  kind text not null check(kind in ('EQUAL','AMOUNT','ITEMS','MERGE')), details jsonb not null,
  operator_user_id uuid not null references public.staff_profiles(id), created_at timestamptz not null default now(),
  foreign key(venue_id,source_account_id) references public.accounts(venue_id,id), foreign key(venue_id,target_account_id) references public.accounts(venue_id,id)
);
create table public.cash_reconciliations (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), service_session_id uuid not null, cash_register_id uuid not null,
  opening_float_cents bigint not null, cash_theoretical_cents bigint not null, cash_actual_cents bigint not null check(cash_actual_cents>=0),
  difference_cents bigint generated always as (cash_actual_cents-cash_theoretical_cents) stored,
  snapshot jsonb not null, created_by uuid not null references public.staff_profiles(id), authorized_by uuid references public.staff_profiles(id),
  created_at timestamptz not null default now(), unique(service_session_id,cash_register_id),
  foreign key(venue_id,service_session_id) references public.service_sessions(venue_id,id), foreign key(venue_id,cash_register_id) references public.cash_registers(venue_id,id)
);
create table private.provider_events (
  provider text not null, event_id text not null, payment_id uuid references public.payments(id),
  event_type text not null, payload_hash text not null, processed_at timestamptz, received_at timestamptz not null default now(),
  primary key(provider,event_id)
);
create table public.print_jobs (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), print_device_id uuid not null,
  account_id uuid, order_id uuid, kind text not null check(kind in ('COURTESY','RECEIPT','KITCHEN')),
  status public.print_job_status not null default 'QUEUED', payload jsonb not null,
  attempts integer not null default 0, last_error_code text, lease_until timestamptz, lease_token uuid,
  requested_by uuid not null references public.staff_profiles(id), idempotency_key uuid not null unique,
  created_at timestamptz not null default now(), completed_at timestamptz,
  foreign key(venue_id,print_device_id) references public.print_devices(venue_id,id),
  foreign key(venue_id,account_id) references public.accounts(venue_id,id), foreign key(venue_id,order_id) references public.orders(venue_id,id),
  version bigint not null default 1, updated_at timestamptz not null default now()
);

create table public.audit_log (
  id uuid not null default gen_random_uuid(), timestamp timestamptz not null default now(),
  venue_id uuid, actor_type text not null, actor_user_id uuid, actor_role public.user_role,
  customer_session_id uuid, action text not null, resource_type text not null, resource_id uuid,
  operation text not null, result text not null, device_id uuid, session_id uuid,
  cash_register_id uuid, service_session_id uuid, table_id uuid, account_id uuid, order_id uuid, payment_id uuid,
  old_values jsonb, new_values jsonb, metadata jsonb not null default '{}',
  correlation_id uuid not null, request_id uuid not null,
  offline_origin boolean not null default false, synced_at timestamptz,
  impersonated_by uuid, impersonation_write_enabled boolean not null default false,
  primary key(timestamp,id)
) partition by range(timestamp);
create table public.audit_log_default partition of public.audit_log default;
create index audit_lookup on public.audit_log(venue_id,timestamp desc);
create index audit_actor on public.audit_log(actor_user_id,timestamp desc);
create index audit_resource on public.audit_log(resource_type,resource_id,timestamp desc);
create index audit_correlation on public.audit_log(correlation_id);
create table public.telemetry_events (
  id bigint generated always as identity primary key, created_at timestamptz not null default now(),
  venue_id uuid references public.venues(id), event text not null, environment text not null,
  release_version text not null, request_id uuid, correlation_id uuid, properties jsonb not null default '{}'
);
create index telemetry_retention on public.telemetry_events(created_at);
create table public.offline_authorization_snapshots (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.staff_profiles(id),
  device_id uuid not null references public.registered_devices(id), claims jsonb not null, signature text not null,
  issued_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz
);
create table public.offline_sync_events (
  id uuid primary key default gen_random_uuid(), client_event_id uuid not null, idempotency_key uuid not null,
  user_id uuid not null references public.staff_profiles(id), device_id uuid not null references public.registered_devices(id),
  venue_id uuid not null references public.venues(id), resource_type text not null, resource_id uuid,
  operation text not null, base_version bigint not null, payload jsonb not null,
  sync_status public.sync_status not null default 'PENDING', created_at_local timestamptz not null,
  received_at timestamptz not null default now(), synced_at timestamptz, result jsonb,
  unique(user_id,client_event_id), unique(user_id,idempotency_key), unique(venue_id,id)
);
create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(), venue_id uuid not null references public.venues(id), sync_event_id uuid not null,
  reason_code text not null, server_snapshot jsonb not null,
  status text not null default 'OPEN' check(status in ('OPEN','RESOLVED','DISCARDED')),
  resolution jsonb, resolved_by uuid references public.staff_profiles(id), created_at timestamptz not null default now(), resolved_at timestamptz,
  foreign key(venue_id,sync_event_id) references public.offline_sync_events(venue_id,id)
);
create table public.system_errors (
  id uuid primary key default gen_random_uuid(), venue_id uuid references public.venues(id), code text not null,
  operation text not null, request_id uuid not null, correlation_id uuid not null, context jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.system_metrics (
  id bigint generated always as identity primary key, venue_id uuid references public.venues(id), name text not null,
  value numeric not null, dimensions jsonb not null default '{}', measured_at timestamptz not null default now()
);
create table public.incidents (
  id uuid primary key default gen_random_uuid(), venue_id uuid references public.venues(id), component text not null,
  severity public.incident_severity not null, title text not null, impact text not null,
  status text not null default 'OPEN' check(status in ('OPEN','INVESTIGATING','MITIGATED','RESOLVED')),
  owner_id uuid references public.staff_profiles(id), started_at timestamptz not null default now(), resolved_at timestamptz, postmortem text,
  version bigint not null default 1, updated_at timestamptz not null default now()
);
create table public.incident_events (
  id uuid primary key default gen_random_uuid(), incident_id uuid not null references public.incidents(id), actor_id uuid references public.staff_profiles(id),
  action text not null, detail text not null, created_at timestamptz not null default now()
);
create table public.backup_metadata (
  id uuid primary key default gen_random_uuid(), status text not null check(status in ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  scope text not null default 'INSTALLATION', storage_reference text, checksum text, includes_auth boolean not null default false,
  includes_storage boolean not null default false, started_at timestamptz, completed_at timestamptz,
  last_restore_test_at timestamptz, integrity_verified boolean not null default false, retention_until timestamptz, error_code text,
  created_at timestamptz not null default now()
);
create table public.restore_jobs (
  id uuid primary key default gen_random_uuid(), backup_id uuid not null references public.backup_metadata(id),
  pre_restore_backup_id uuid references public.backup_metadata(id), requested_by uuid not null references public.staff_profiles(id),
  scope text not null default 'INSTALLATION', status text not null default 'REQUESTED' check(status in ('REQUESTED','CONFIRMED','SNAPSHOTTING','RESTORING','VERIFYING','SUCCEEDED','FAILED')),
  verification jsonb, created_at timestamptz not null default now(), completed_at timestamptz, error_code text
);
create table public.application_releases (
  id uuid primary key default gen_random_uuid(), version text not null, git_commit text not null, build_id text not null unique,
  released_at timestamptz not null default now(), released_by text not null, database_schema_version text not null,
  notes text not null, status text not null check(status in ('STAGING','RELEASED','ROLLED_BACK','FAILED'))
);
create table public.database_migrations_metadata (
  version text primary key, checksum text not null, applied_at timestamptz not null default now(), release_id uuid references public.application_releases(id)
);

create function private.immutable_record() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'IMMUTABLE_RECORD' using errcode='42501'; end $$;
create trigger audit_immutable before update or delete on public.audit_log for each row execute function private.immutable_record();
create trigger audit_no_truncate before truncate on public.audit_log for each statement execute function private.immutable_record();
create trigger reconciliation_immutable before update or delete on public.cash_reconciliations for each row execute function private.immutable_record();

-- Allowlist audit fields: credentials and customer PII never enter immutable payloads.
create function private.audit_values(p_value jsonb) returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(coalesce(p_value,'{}'::jsonb))
   where key=any(array['id','venue_id','role','scope','active','status','technical_status','version','price_cents','local_price_cents',
    'availability','quantity','unit_price_cents','amount_cents','tip_cents','currency','method','account_id','order_id','step_id','dish_id',
    'station_id','table_id','zone_id','cash_register_id','service_session_id','licensed','enabled','reservations_enabled',
    'customer_ordering','payment_methods','opening_float_cents','cash_theoretical_cents','cash_actual_cents','difference_cents',
    'authorized_by','operator_user_id','assigned_waiter_id','mode','max_covers_service','max_covers_per_slot','revoked_at'])
$$;
create function private.audit(p_action text,p_resource text,p_id uuid,p_venue uuid,p_old jsonb default null,p_new jsonb default null,p_result text default 'SUCCESS')
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid := gen_random_uuid(); subject uuid := private.effective_user_id(); request_headers jsonb;
begin
  request_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if request_headers->>'x-request-id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then rid:=(request_headers->>'x-request-id')::uuid; end if;
  insert into public.audit_log(venue_id,actor_type,actor_user_id,actor_role,action,resource_type,resource_id,operation,result,
    session_id,old_values,new_values,request_id,correlation_id,impersonated_by,impersonation_write_enabled)
  values(p_venue,case when auth.uid() is null then 'SYSTEM' when exists(select 1 from public.staff_profiles where id=coalesce(subject,auth.uid())) then 'STAFF' else 'CUSTOMER' end,
    coalesce(subject,auth.uid()),case when auth.uid() is null then 'SYSTEM'::public.user_role else coalesce((select role from public.staff_profiles where id=coalesce(subject,auth.uid())),'CUSTOMER'::public.user_role) end,
    p_action,p_resource,p_id,p_action,p_result,private.jwt_session_id(),private.audit_values(p_old),private.audit_values(p_new),rid,rid,
    case when private.impersonation_id() is not null then auth.uid() end,
    coalesce((select write_enabled from private.impersonation_sessions where id=private.impersonation_id()),false));
end $$;
create function private.audit_row() returns trigger language plpgsql security definer set search_path='' as $$
declare old_json jsonb; new_json jsonb; resource uuid; venue uuid;
begin
  if tg_op <> 'INSERT' then old_json := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_json := to_jsonb(new); end if;
  if coalesce(new_json,old_json)->>'id' ~ '^[0-9a-f-]{36}$' then resource := (coalesce(new_json,old_json)->>'id')::uuid; end if;
  venue := (coalesce(new_json,old_json)->>'venue_id')::uuid;
  perform private.audit(upper(tg_table_name)||'_'||tg_op,tg_table_name,resource,venue,old_json,new_json);
  return coalesce(new,old);
end $$;

-- Apply fail-closed table privileges, row auditing, and revisions to all entities.
do $$ declare t record;
begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security',t.tablename);
    execute format('revoke all on public.%I from anon, authenticated',t.tablename);
    if t.tablename not in ('audit_log','audit_log_default','telemetry_events','system_metrics','system_errors') then
      execute format('create trigger audit_mutation after insert or update or delete on public.%I for each row execute function private.audit_row()',t.tablename);
    end if;
    if exists(select 1 from information_schema.columns where table_schema='public' and table_name=t.tablename and column_name='version') then
      execute format('create trigger touch_version before update on public.%I for each row execute function private.touch_version()',t.tablename);
    end if;
  end loop;
end $$;
revoke all on all tables in schema private from anon,authenticated;
revoke all on all functions in schema private from public;
commit;
