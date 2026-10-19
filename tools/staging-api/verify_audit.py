#!/usr/bin/env python3
"""A.1 checks (port of tools/audit-local-pg/verify.sh) on a staging project.
Every mutating probe runs in one request = one implicit transaction that is
expected to fail, so nothing persists. Fixture rows are inserted in the same
transaction as the probe and roll back with it."""
import json, os, re, subprocess, sys, time

REF = os.environ.get("PLATEFORM_STAGING_REF", "")
# Development and production must never be the target of these scripts.
if not re.fullmatch(r"[a-z0-9]{20}", REF) or REF == "abdxvlykasqmknexxhjo":
    sys.exit("PLATEFORM_STAGING_REF must name a disposable staging project")
URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"
HERE = os.path.dirname(os.path.abspath(__file__))
# One fixture row in every leaf partition (range leaf: lower bound + 1 day;
# default leaf: now()), so UPDATE/DELETE probes always touch a row.
FIX = ("insert into public.audit_log(timestamp,actor_type,action,resource_type,operation,result,request_id,correlation_id) "
       "select coalesce(nullif(split_part(pg_get_expr(c.relpartbound,c.oid),'''',2),'')::timestamptz+interval '1 day',now()),"
       "'SYSTEM','A1_FIXTURE','test','INSERT','SUCCESS',gen_random_uuid(),gen_random_uuid() "
       "from pg_partition_tree('public.audit_log') p join pg_class c on c.oid=p.relid where p.isleaf;")
# Appended to every probe: if the probe itself does not fail, the transaction
# still aborts here, so no probe can ever commit fixture rows or DDL.
GUARD = " do $g$ begin raise exception 'PROBE_DID_NOT_FAIL'; end $g$;"


def q(sql):
    for _ in range(10):
        r = subprocess.run(["curl", "-sS", "-m", "300", "-X", "POST", URL, "-H", "Content-Type: application/json",
                            "--data-binary", "@-"], input=json.dumps({"query": sql}).encode(), capture_output=True)
        out = r.stdout.decode()
        if "Too Many Requests" in out:
            time.sleep(30)
            continue
        time.sleep(0.4)
        return out
    return out


res = {"pass": 0, "fail": 0}


def ok(n):
    res["pass"] += 1
    print("PASS", n)


def ko(n, o):
    res["fail"] += 1
    print("FAIL", n, "::", o[:400])


def expect_err(n, sql, needle):
    o = q(sql + GUARD)
    (ok if any(x in o for x in needle.split("|")) else lambda m: ko(m, o))(n)


def val(sql):
    o = q(sql)
    try:
        return list(json.loads(o)[0].values())[0]
    except Exception:
        return o


def expect_val(n, sql, want):
    v = val(sql)
    ok(n) if v == want else ko(n, repr(v))


expect_val("no pause trigger", "select count(*)::int c from pg_trigger where tgname='plateform_dev_pause_audit'", 0)
expect_val("no violations", "select cardinality(private.audit_append_only_violations(true)) c", 0)
expect_val("event triggers installed", "select count(*)::int c from pg_event_trigger where evtname like 'plateform_audit_%'", 2)
leaves = [r["t"] for r in json.loads(q("select relid::regclass::text t from pg_partition_tree('public.audit_log') where isleaf order by 1"))]
for t in leaves:
    expect_err(f"truncate {t}", FIX + f"truncate {t};", "IMMUTABLE_RECORD")
    expect_err(f"update {t}", FIX + f"update {t} set action='X';", "IMMUTABLE_RECORD")
    expect_err(f"delete {t}", FIX + f"delete from {t};", "IMMUTABLE_RECORD")
    expect_err(f"service_role truncate {t}", f"set local role service_role; truncate {t};", "permission denied")
    expect_err(f"service_role trigger {t}", f"set local role service_role; create trigger d before insert on {t} for each row execute function private.immutable_record();", "permission denied|must be owner")
expect_err("replica update", FIX + "set local session_replication_role=replica; update public.audit_log set action='X';", "IMMUTABLE_RECORD|permission denied")
expect_err("replica truncate default", FIX + "set local session_replication_role=replica; truncate public.audit_log_default;", "IMMUTABLE_RECORD|permission denied")
T = [t for t in leaves if t != "audit_log_default" and not t.endswith(".audit_log_default")][0]
DISCARD = "create function private.a1_discard() returns trigger language plpgsql as $$ begin return null; end $$;"
expect_err("disable immutable", "alter table public.audit_log disable trigger audit_immutable;", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("disable truncate guard", f"alter table {T} disable trigger audit_no_truncate;", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("discard trigger parent", DISCARD + "create trigger d before insert on public.audit_log for each row execute function private.a1_discard();", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("discard rule", "create rule d as on insert to public.audit_log do instead nothing;", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("detach partition", f"alter table public.audit_log detach partition {T};", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("drop truncate guard", f"drop trigger audit_no_truncate on {T};", "AUDIT_APPEND_ONLY_DDL_REJECTED")
expect_err("drop partition", f"drop table {T};", "AUDIT_APPEND_ONLY_DDL_REJECTED")
expect_err("grant truncate", f"grant truncate on {T} to service_role;", "AUDIT_APPEND_ONLY_VIOLATION")
expect_err("smoke script", open(os.path.join(HERE, "../../supabase/tests/audit-capture-smoke.sql")).read().replace("RAISE NOTICE 'AUDIT_INSERT_IMMUTABILITY_SMOKE_TEST_PASSED'", "RAISE EXCEPTION 'AUDIT_INSERT_IMMUTABILITY_SMOKE_TEST_PASSED'"), "AUDIT_INSERT_IMMUTABILITY_SMOKE_TEST_PASSED")
expect_val("rotation creates/keeps guarded partitions", "select private.ensure_audit_monthly_partitions(8)>=0 c", True)
expect_val("no violations after rotation", "select cardinality(private.audit_append_only_violations(true)) c", 0)
expect_val("no new fixture rows persisted", "select count(*)::int c from public.audit_log where action='A1_FIXTURE'", int(sys.argv[1]) if len(sys.argv) > 1 else 0)
expect_val("discard function not persisted", "select count(*)::int c from pg_proc where proname='a1_discard'", 0)
print(f"AUDIT_APPEND_ONLY_STAGING pass={res['pass']} fail={res['fail']}")
