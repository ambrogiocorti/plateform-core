#!/usr/bin/env python3
"""Replays supabase/migrations on a disposable STAGING project through the
Supabase Management API (the caller supplies auth, e.g. a proxy-injected
personal access token; no token is read here). Each file plus its
schema_migrations row is sent as one multi-statement query (implicit
transaction), skipping versions already recorded. Stops at first failure."""
import json, os, re, subprocess, sys, time

REF = os.environ.get("PLATEFORM_STAGING_REF", "")
# Development and production must never be the target of these scripts.
if not re.fullmatch(r"[a-z0-9]{20}", REF) or REF == "abdxvlykasqmknexxhjo":
    sys.exit("PLATEFORM_STAGING_REF must name a disposable staging project")
URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"
MIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../supabase/migrations")
TXN = re.compile(r"^\s*(begin|commit|start transaction)(\s+transaction|\s+work)?\s*;\s*$", re.I | re.M)


def q(sql, timeout=300):
    for attempt in range(12):
        r = subprocess.run(["curl", "-sS", "-m", str(timeout), "-X", "POST", URL,
                            "-H", "Content-Type: application/json", "--data-binary", "@-"],
                           input=json.dumps({"query": sql}).encode(), capture_output=True)
        out = r.stdout.decode()
        if "Too Many Requests" in out:
            time.sleep(30)
            continue
        if r.returncode == 0 and "connection timeout" not in out:
            try:
                return json.loads(out)
            except ValueError:
                return {"message": out}
        time.sleep(min(2 ** (attempt + 1), 30))
    return {"message": f"transport failure: {r.stderr.decode()} {out}"}


def lit(s):
    tag = "$plf$"
    assert tag not in s
    return tag + s + tag


def main():
    stop_at = sys.argv[1] if len(sys.argv) > 1 else None
    done = q("select coalesce(json_agg(version),'[]') v from supabase_migrations.schema_migrations")
    if isinstance(done, dict):
        sys.exit(f"cannot read history: {done}")
    applied = set(done[0]["v"])
    files = sorted(f for f in os.listdir(MIG) if f.endswith(".sql"))
    n = 0
    for f in files:
        version, name = f[:-4].split("_", 1)
        if version in applied:
            continue
        if stop_at and version > stop_at:
            break
        raw = open(os.path.join(MIG, f), encoding="utf-8").read()
        body = TXN.sub("", raw)
        sql = (body.rstrip().rstrip(";") + ";\n"
               "insert into supabase_migrations.schema_migrations(version,name,statements) values ("
               f"{lit(version)},{lit(name)},array[{lit(raw)}]);")
        t = time.time()
        res = q(sql)
        if isinstance(res, dict) and "message" in res:
            print(f"FAILED {f}: {res['message'][:2000]}")
            sys.exit(1)
        n += 1
        time.sleep(0.5)
        print(f"OK {f} {time.time() - t:.1f}s", flush=True)
    print(f"DONE applied_now={n} total_files={len(files)}")


main()
