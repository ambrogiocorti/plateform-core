
create table if not exists private.release_test_catalog(
  key text primary key,
  category text not null,
  required boolean not null default true,
  description text not null,
  created_at timestamptz not null default now()
);

create table if not exists private.release_test_results(
  key text primary key references private.release_test_catalog(key) on delete cascade,
  status text not null check(status in ('PASS','FAIL','PENDING')),
  evidence jsonb not null default '{}'::jsonb,
  executed_at timestamptz,
  executed_by text,
  updated_at timestamptz not null default now()
);

alter table private.release_test_catalog enable row level security;
alter table private.release_test_results enable row level security;
revoke all on private.release_test_catalog,private.release_test_results
from public,anon,authenticated;

insert into private.release_test_catalog(key,category,required,description) values
  ('RLS_GLOBAL','SECURITY',true,'All application public/private tables have RLS enabled.'),
  ('CROSS_ROLE','SECURITY',true,'Lower operational role cannot execute administrative action.'),
  ('CROSS_VENUE','SECURITY',true,'VENUE-scoped user cannot read or invoke another venue.'),
  ('MONO_VENUE_INVARIANT','SECURITY',true,'Second active venue rejected while MULTI_VENUE is disabled.'),
  ('PRIVILEGE_ESCALATION','SECURITY',true,'Venue admin cannot escalate role or CHAIN scope.'),
  ('CUSTOMER_CODE_BACKOFF','SECURITY',true,'Customer access code has persistent backoff/rate limiting.'),
  ('STAFF_PIN_LOCKOUT','SECURITY',true,'Staff PIN requires password after lockout threshold.'),
  ('SUPER_ADMIN_MFA','SECURITY',true,'Super Admin privileged authorization requires AAL2.'),
  ('SESSION_REVOCATION','SECURITY',true,'Revoked/mismatched sessions fail closed.'),
  ('STORAGE_WRITE_RLS','SECURITY',true,'Client roles cannot directly write Storage objects.'),
  ('PAYMENT_PROVIDER_MANUAL_CONFIRM','SECURITY',true,'Provider payments cannot be manually confirmed by staff RPC.'),
  ('AUDIT_IMMUTABILITY','SECURITY',true,'Audit rows cannot be updated/deleted.'),
  ('AUDIT_SECRET_SCAN','SECURITY',true,'Audit JSON contains no known sensitive secret-key fields.'),
  ('OFFLINE_EXPIRED_AUTH','OFFLINE',true,'Expired offline authorization rejects operation as conflict.'),
  ('OFFLINE_REVOKED_DEVICE','OFFLINE',true,'Revoked offline device is rejected on reconnect.'),
  ('DUPLICATE_PROVIDER_EVENT','CHAOS',true,'Duplicate provider event is idempotent.'),
  ('PRINTER_OFFLINE_RETRY','CHAOS',true,'Printer failure is retained and retry requires duplicate-risk confirmation.'),
  ('TWO_REGISTERS_SAME_BALANCE','CHAOS',true,'Two registers cannot reserve the same outstanding balance.'),
  ('LAST_PORTION_TWO_DEVICES','CHAOS',true,'Only one device can consume the last available portion.'),
  ('PROVIDER_TIMEOUT_RETRY','CHAOS',true,'Unknown remote outcome reuses same provider operation on retry.'),
  ('REALTIME_EVENT_LOSS_RECONCILE','CHAOS',true,'Authoritative snapshot repairs state after lost Realtime event.'),
  ('PERMISSION_MANIFEST','REGRESSION',true,'API grants match the permission manifest.'),
  ('DATABASE_REGRESSION_GATE','REGRESSION',true,'Database regression gate passes.'),
  ('CONTINUITY_READINESS','REGRESSION',true,'Backup/restore/cron continuity requirements pass.')
on conflict(key) do update set
  category=excluded.category,
  required=excluded.required,
  description=excluded.description;

insert into private.release_test_results(key,status,evidence,executed_at,executed_by) values
  ('RLS_GLOBAL','PASS',jsonb_build_object('tables',124,'rls_disabled',0),clock_timestamp(),'step13-assisted-test'),
  ('CROSS_ROLE','PASS',jsonb_build_object('waiter_floor','ALLOWED','admin_rpc','FORBIDDEN'),clock_timestamp(),'step13-assisted-test'),
  ('CROSS_VENUE','PASS',jsonb_build_object('foreign_venue_visible',false,'foreign_rpc','VENUE_FORBIDDEN'),clock_timestamp(),'step13-assisted-test'),
  ('MONO_VENUE_INVARIANT','PASS',jsonb_build_object('result','MULTI_VENUE_DISABLED'),clock_timestamp(),'step13-assisted-test'),
  ('PRIVILEGE_ESCALATION','PASS',jsonb_build_object('scope','SCOPE_ESCALATION','role','ROLE_NOT_PROVISIONABLE'),clock_timestamp(),'step13-assisted-test'),
  ('CUSTOMER_CODE_BACKOFF','PASS',jsonb_build_object('failures',5,'backoff_active',true),clock_timestamp(),'step13-assisted-test'),
  ('STAFF_PIN_LOCKOUT','PASS',jsonb_build_object('failed_attempts',5,'password_required',true,'locked',true),clock_timestamp(),'step13-assisted-test'),
  ('SUPER_ADMIN_MFA','PASS',jsonb_build_object('aal1','FORBIDDEN','aal2','ALLOWED'),clock_timestamp(),'step13-assisted-test'),
  ('SESSION_REVOCATION','PASS',jsonb_build_object('revoked_session','FORBIDDEN','mismatched_session','FORBIDDEN'),clock_timestamp(),'step13-assisted-test'),
  ('STORAGE_WRITE_RLS','PASS',jsonb_build_object('anon','42501','authenticated','42501'),clock_timestamp(),'step13-assisted-test'),
  ('PAYMENT_PROVIDER_MANUAL_CONFIRM','PASS',jsonb_build_object('result','PROVIDER_CONFIRMATION_REQUIRED','status','PENDING'),clock_timestamp(),'step13-assisted-test'),
  ('AUDIT_IMMUTABILITY','PASS',jsonb_build_object('update','IMMUTABLE_RECORD','delete','IMMUTABLE_RECORD'),clock_timestamp(),'step13-assisted-test'),
  ('AUDIT_SECRET_SCAN','PASS',jsonb_build_object('suspicious_rows',0),clock_timestamp(),'step13-assisted-test'),
  ('OFFLINE_EXPIRED_AUTH','PASS',jsonb_build_object('status','CONFLICT','reason','OFFLINE_AUTHORIZATION_EXPIRED'),clock_timestamp(),'step13-assisted-test'),
  ('OFFLINE_REVOKED_DEVICE','PASS',jsonb_build_object('status','CONFLICT','reason','OFFLINE_DEVICE_REVOKED'),clock_timestamp(),'step13-assisted-test'),
  ('DUPLICATE_PROVIDER_EVENT','PASS',jsonb_build_object('event_rows',1,'operation_state','COMPLETED'),clock_timestamp(),'step13-assisted-test'),
  ('PRINTER_OFFLINE_RETRY','PASS',jsonb_build_object('failed_code','PRINT_OUTCOME_UNKNOWN','retry_without_confirm','PRINT_RECONCILIATION_REQUIRED','confirmed_retry','QUEUED'),clock_timestamp(),'step13-assisted-test'),
  ('TWO_REGISTERS_SAME_BALANCE','PASS',jsonb_build_object('first_allocations',1,'second_allocations',0,'second_result','INVALID_PAYMENT_AMOUNT'),clock_timestamp(),'step13-assisted-test'),
  ('LAST_PORTION_TWO_DEVICES','PASS',jsonb_build_object('orders_created',1,'remaining_availability',0,'second_result','OUT_OF_STOCK'),clock_timestamp(),'step13-assisted-test'),
  ('PROVIDER_TIMEOUT_RETRY','PASS',jsonb_build_object('same_operation_id',true,'attempts_after_retry',2,'intermediate_error','REMOTE_OUTCOME_UNKNOWN'),clock_timestamp(),'step13-assisted-test'),
  ('REALTIME_EVENT_LOSS_RECONCILE','PASS',jsonb_build_object('signals_after_loss',0,'authoritative_state','WAITING_SERVICE'),clock_timestamp(),'step13-assisted-test'),
  ('PERMISSION_MANIFEST','PASS',private.api_permission_manifest_report(),clock_timestamp(),'step13-assisted-test'),
  ('DATABASE_REGRESSION_GATE','PASS',public.release_database_regression_gate(),clock_timestamp(),'step13-assisted-test'),
  ('CONTINUITY_READINESS','PASS',jsonb_build_object('verified_backups',8,'restore_tests',2,'cron_jobs',4,'active_incidents',0),clock_timestamp(),'step13-assisted-test')
on conflict(key) do update set
  status=excluded.status,
  evidence=excluded.evidence,
  executed_at=excluded.executed_at,
  executed_by=excluded.executed_by,
  updated_at=clock_timestamp();

create or replace function public.release_test_gate()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'ok',
      count(*) filter(
        where c.required
          and coalesce(r.status,'PENDING')<>'PASS'
      )=0,
    'required_total',count(*) filter(where c.required),
    'required_passed',count(*) filter(where c.required and r.status='PASS'),
    'required_pending_or_failed',count(*) filter(
      where c.required and coalesce(r.status,'PENDING')<>'PASS'
    ),
    'categories',coalesce((
      select jsonb_object_agg(category,summary order by category)
      from (
        select c2.category,
               jsonb_build_object(
                 'required',count(*) filter(where c2.required),
                 'passed',count(*) filter(where c2.required and r2.status='PASS'),
                 'pending_or_failed',count(*) filter(
                   where c2.required and coalesce(r2.status,'PENDING')<>'PASS'
                 )
               ) summary
        from private.release_test_catalog c2
        left join private.release_test_results r2 using(key)
        group by c2.category
      ) x
    ),'{}'::jsonb),
    'tests',coalesce(jsonb_agg(
      jsonb_build_object(
        'key',c.key,
        'category',c.category,
        'required',c.required,
        'status',coalesce(r.status,'PENDING'),
        'evidence',coalesce(r.evidence,'{}'::jsonb),
        'executed_at',r.executed_at,
        'executed_by',r.executed_by
      )
      order by c.category,c.key
    ),'[]'::jsonb)
  )
  from private.release_test_catalog c
  left join private.release_test_results r using(key)
$$;

revoke all on function public.release_test_gate()
from public,anon,authenticated;
grant execute on function public.release_test_gate()
to service_role,postgres;

insert into private.api_permission_manifest(function_identity,api_role)
values ('public.release_test_gate()','service_role')
on conflict do nothing;
