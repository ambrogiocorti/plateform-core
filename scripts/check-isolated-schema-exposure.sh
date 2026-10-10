#!/usr/bin/env bash
# Read-only exposed schema regression gate against DISPOSABLE local Supabase.
# This is not proof of real JWT/session or cross-tenant security.
set -euo pipefail
db_container="$(docker ps --filter 'name=supabase_db_' --format '{{.Names}}' | head -n 1)"
if [[ -z "$db_container" ]]; then
  echo 'SCHEMA_EXPOSURE_GATE=BLOCKED_NO_LOCAL_DB'
  exit 1
fi
query() {
  docker exec "$db_container" psql --username postgres --dbname postgres \
    --no-psqlrc --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --command "$1"
}
result="$(query "
with public_tables as (
  select c.oid,c.relname,c.relrowsecurity,
  (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policy_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p')
), policy_audit as (
 select
  count(*) as total,
  count(*) filter (where not relrowsecurity) as missing_rls,
  count(*) filter (where relrowsecurity and policy_count=0) as deny_all,
  count(*) filter (where relrowsecurity and policy_count=0
    and (has_table_privilege('anon',oid,'SELECT')
         or has_table_privilege('authenticated',oid,'SELECT'))) as unreviewed_grants
 from public_tables
), rls as (
 select count(*) as total,
 count(*) filter (where coalesce(qual,'') ilike '%auth.role(%'
                        or coalesce(with_check,'') ilike '%auth.role(%') as auth_role_refs,
 count(*) filter (where coalesce(qual,'') ilike '%user_metadata%'
                        or coalesce(with_check,'') ilike '%user_metadata%') as user_metadata_refs,
 count(*) filter (where cmd='UPDATE' and with_check is null) as update_missing_withcheck
 from pg_policies where schemaname='public'
)
select case when
 (select missing_rls from policy_audit)=0
 and (select total from rls)=110
 and (select deny_all from policy_audit)=5
 and (select unreviewed_grants from policy_audit)=0
 and (select auth_role_refs from rls)=0
 and (select user_metadata_refs from rls)=0
 and (select update_missing_withcheck from rls)=0
 and (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('v','m'))=0
 then 'PASS' else 'FAIL' end;
")"
if [[ "$result" != 'PASS' ]]; then
 echo 'SCHEMA_EXPOSURE_GATE=FAILED'
 exit 1
fi
echo 'SCHEMA_EXPOSURE_GATE=PASSED'
