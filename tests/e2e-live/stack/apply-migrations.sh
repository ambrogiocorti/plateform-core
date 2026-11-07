#!/usr/bin/env bash
# Replays supabase/migrations in order on the disposable local stack.
# Only pg_cron's CREATE EXTENSION is stripped (host-provided on Supabase; SQL fixture in bootstrap.sql).
set -euo pipefail
DB_URL="${E2E_DB_URL:-postgres://postgres@127.0.0.1:54322/postgres}"
cd "$(dirname "$0")/../../.."
for file in supabase/migrations/*.sql; do
  name="$(basename "$file" .sql)"
  version="${name%%_*}"
  done_already="$(psql "$DB_URL" -Atqc "select 1 from supabase_migrations.schema_migrations where version='$version'")"
  [ -n "$done_already" ] && continue
  sed -E '/^[[:space:]]*create extension if not exists pg_cron;[[:space:]]*$/Id' "$file" \
    | PGOPTIONS="-c client_min_messages=error" psql "$DB_URL" -X -q -1 -v ON_ERROR_STOP=1 -f - >/dev/null \
    || { echo "Migration $name failed" >&2; exit 1; }
  psql "$DB_URL" -X -q -c "insert into supabase_migrations.schema_migrations(version,name) values('$version','${name#*_}')"
done
echo "Applied $(psql "$DB_URL" -Atqc 'select count(*) from supabase_migrations.schema_migrations') migrations"
