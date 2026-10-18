#!/usr/bin/env bash
# Replays every migration on a DISPOSABLE local PostgreSQL reached only through
# a Unix socket directory, then verifies the append-only audit guards.
# Never point this at a shared, linked, staging or production database.
#   PLATEFORM_LOCAL_PG_SOCKET=/path/to/socket/dir PLATEFORM_LOCAL_PG_PORT=55432 \
#     tools/audit-local-pg/replay.sh
set -euo pipefail
SOCKET="${PLATEFORM_LOCAL_PG_SOCKET:?socket directory required}"
PORT="${PLATEFORM_LOCAL_PG_PORT:-55432}"
DB=plateform_audit_local_replay
if [[ "$SOCKET" != /* || ! -d "$SOCKET" ]]; then
  echo 'LOCAL_SOCKET_DIRECTORY_REQUIRED' >&2
  exit 2
fi
unset PGHOST PGHOSTADDR PGSERVICE PGDATABASE DATABASE_URL SUPABASE_DB_URL
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
P=(psql -X -q -h "$SOCKET" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
# Reuse the PGlite harness fixture (Supabase-owned schemas and API roles).
node -e "
const s=require('fs').readFileSync('tests/database/harness.ts','utf8');
const a=s.indexOf('await db.exec(\`')+15,b=s.indexOf('\`);',a);
let sql=s.slice(a,b).replace(/^\s*create role (\w+) nologin( bypassrls)?;/gm,
 (_,r,x)=>'do \$r\$ begin if not exists (select 1 from pg_roles where rolname=\''+r+'\') then create role '+r+' nologin'+(x||'')+'; end if; end \$r\$;');
require('fs').writeFileSync('$WORK/prelude.sql','create schema if not exists extensions;\ncreate extension if not exists pgcrypto with schema extensions;\n'+sql);"
"${P[@]}" -c "drop database if exists $DB" -c "create database $DB"
"${P[@]}" -d "$DB" -f "$WORK/prelude.sql" >/dev/null
n=0
for f in supabase/migrations/*.sql; do
  sed -E '/^create extension if not exists pg_cron;[[:space:]]*$/Id' "$f" >"$WORK/m.sql"
  if ! "${P[@]}" -d "$DB" -f "$WORK/m.sql" >/dev/null 2>"$WORK/err"; then
    echo "MIGRATION_FAILED $f" >&2
    head -20 "$WORK/err" >&2
    exit 1
  fi
  n=$((n + 1))
done
echo "LOCAL_POSTGRES_REPLAYED=$n"
PLATEFORM_LOCAL_PG_DB="$DB" "$(dirname "$0")/verify.sh"
