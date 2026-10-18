#!/bin/bash
# Verifies migration 20261018103000 on the disposable DB built by replay.sh.
# It inserts five fixture audit rows: run it only on that throwaway database.
SOCKET="${PLATEFORM_LOCAL_PG_SOCKET:?socket directory required}"
PORT="${PLATEFORM_LOCAL_PG_PORT:-55432}"
DB="${PLATEFORM_LOCAL_PG_DB:-plateform_audit_local_replay}"
P="psql -X -q -At -h $SOCKET -p $PORT -U postgres -d $DB"
pass=0; fail=0
ok()   { echo "PASS $1"; pass=$((pass+1)); }
ko()   { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
expect_err() { out=$($P -c "$2" 2>&1); if echo "$out" | grep -q "$3"; then ok "$1"; else ko "$1" "$out"; fi; }
expect_val() { out=$($P -c "$2" 2>&1); if [ "$out" = "$3" ]; then ok "$1"; else ko "$1" "$out"; fi; }
$P -c "insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,request_id,correlation_id)
  select date_trunc('month',now())+make_interval(months=>n)+interval '1 day','SYSTEM','A1_FIXTURE','test','INSERT','SUCCESS',gen_random_uuid(),gen_random_uuid() from generate_series(0,4) n"
expect_val "no pause trigger" "select count(*) from pg_trigger where tgname='plateform_dev_pause_audit'" "0"
expect_val "no violations" "select cardinality(private.audit_append_only_violations(true))" "0"
expect_val "event triggers installed" "select count(*) from pg_event_trigger where evtname like 'plateform_audit_%'" "2"
for t in $($P -c "select relid::regclass from pg_partition_tree('public.audit_log') where isleaf order by 1"); do
  expect_err "truncate $t" "truncate $t" IMMUTABLE_RECORD
  expect_err "update $t" "update $t set action='X'" IMMUTABLE_RECORD
  expect_err "delete $t" "delete from $t" IMMUTABLE_RECORD
  expect_err "service_role truncate $t" "set role service_role; truncate $t" "permission denied"
  expect_err "service_role trigger $t" "set role service_role; create trigger d before insert on $t for each row execute function private.immutable_record()" "permission denied\|must be owner"
done
expect_err "replica update" "begin; set local session_replication_role=replica; update public.audit_log set action='X'" IMMUTABLE_RECORD
expect_err "replica truncate default" "begin; set local session_replication_role=replica; truncate public.audit_log_default" IMMUTABLE_RECORD
$P -c "create function private.a1_discard() returns trigger language plpgsql as \$\$ begin return null; end \$\$"
T=$($P -c "select relid::regclass from pg_partition_tree('public.audit_log') where isleaf and relid<>'public.audit_log_default'::regclass order by 1 limit 1")
expect_err "disable immutable" "alter table public.audit_log disable trigger audit_immutable" AUDIT_APPEND_ONLY_VIOLATION
expect_err "disable truncate guard" "alter table $T disable trigger audit_no_truncate" AUDIT_APPEND_ONLY_VIOLATION
expect_err "discard trigger parent" "create trigger d before insert on public.audit_log for each row execute function private.a1_discard()" AUDIT_APPEND_ONLY_VIOLATION
expect_err "discard rule" "create rule d as on insert to public.audit_log do instead nothing" AUDIT_APPEND_ONLY_VIOLATION
expect_err "detach partition" "alter table public.audit_log detach partition $T" AUDIT_APPEND_ONLY_VIOLATION
expect_err "drop truncate guard" "drop trigger audit_no_truncate on $T" AUDIT_APPEND_ONLY_DDL_REJECTED
expect_err "drop partition" "drop table $T" AUDIT_APPEND_ONLY_DDL_REJECTED
expect_err "grant truncate" "grant truncate on $T to service_role" AUDIT_APPEND_ONLY_VIOLATION
$P -c "drop function private.a1_discard()"
expect_err "smoke script" "$(cat supabase/tests/audit-capture-smoke.sql)" AUDIT_INSERT_IMMUTABILITY_SMOKE_TEST_PASSED
expect_val "rotation creates guarded partitions" "select private.ensure_audit_monthly_partitions(8)>0" "t"
expect_val "no violations after rotation" "select cardinality(private.audit_append_only_violations(true))" "0"
expect_val "fixture rows intact" "select count(*) from public.audit_log where action='A1_FIXTURE'" "5"
# Non-superuser path: event trigger creation must degrade to a NOTICE, not abort.
$P -c "do \$r\$ begin if not exists (select 1 from pg_roles where rolname='a1_owner') then create role a1_owner login; end if; end \$r\$; grant create on database $DB to a1_owner"
out=$(psql -X -q -At -h $SOCKET -p $PORT -U a1_owner -d $DB -c "create schema if not exists a1s; create function a1s.f() returns event_trigger language plpgsql as \$\$ begin end \$\$;
do \$p\$ begin execute 'create event trigger a1_probe on ddl_command_end execute function a1s.f()';
exception when insufficient_privilege or feature_not_supported then raise notice 'AUDIT_DDL_EVENT_TRIGGER_NOT_INSTALLED: %',sqlerrm; end \$p\$;" 2>&1)
if echo "$out" | grep -q AUDIT_DDL_EVENT_TRIGGER_NOT_INSTALLED; then ok "non-superuser event trigger fallback"; else ko "non-superuser fallback" "$out"; fi
echo "AUDIT_APPEND_ONLY_LOCAL_PG pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
