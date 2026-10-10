#!/usr/bin/env bash
# Fail-closed privilege regression against a DISPOSABLE reconstructed Supabase DB.
# Does not use real user identities, service-role tokens, or a remote project.
set -euo pipefail

db_container="$(docker ps --filter 'name=supabase_db_' --format '{{.Names}}' | head -n 1)"
if [[ -z "$db_container" ]]; then
  echo 'RPC_SECURITY_GATE=BLOCKED_NO_DISPOSABLE_DB'
  exit 1
fi

query() {
  docker exec "$db_container" psql --username postgres --dbname postgres \
    --no-psqlrc --no-align --tuples-only --set ON_ERROR_STOP=1 \
    --command "$1"
}

grant_result="$(query "
select case when
    not has_function_privilege('anon', 'public.get_account_transfer_targets(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_order_change_center(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_account_transfer_targets(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.get_order_change_center(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_account_transfer_targets(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_order_change_center(uuid)', 'EXECUTE')
    then 'PASS' else 'FAIL' end;
")"
if [[ "$grant_result" != 'PASS' ]]; then
  echo 'RPC_SECURITY_GATE=FAIL_GRANTS'
  exit 1
fi
echo 'RPC_GRANT_MATRIX=PASSED'

expect_denied() {
  local case_name="$1"
  local sql="$2"
  local expected_message="$3"
  local output
  if output="$(query "$sql" 2>&1)"; then
    echo "RPC_SECURITY_GATE=FAIL_UNEXPECTED_SUCCESS:${case_name}"
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    echo "RPC_SECURITY_GATE=FAIL_WRONG_DENIAL:${case_name}"
    # Do not print the query, the full response or any identity/credential.
    exit 1
  fi
  echo "RPC_NEGATIVE_ROLE=${case_name}:PASSED"
}

# The UUID is an intentionally nonexistent fixture, not a real restaurant.
venue_id="00000000-0000-4000-8000-000000000001"
expect_denied 'ANON_ORDER_CHANGE_CENTER' \
  "begin; set local role anon; select public.get_order_change_center('${venue_id}'::uuid);" \
  'permission denied for function get_order_change_center'
expect_denied 'ANON_TRANSFER_TARGETS' \
  "begin; set local role anon; select public.get_account_transfer_targets('${venue_id}'::uuid);" \
  'permission denied for function get_account_transfer_targets'
expect_denied 'AUTHENTICATED_NO_SESSION_ORDER_CHANGE_CENTER' \
  "begin; set local role authenticated; select public.get_order_change_center('${venue_id}'::uuid);" \
  'FORBIDDEN'
expect_denied 'AUTHENTICATED_NO_ACCOUNT_TRANSFER' \
  "begin; set local role authenticated; select public.get_account_transfer_targets('${venue_id}'::uuid);" \
  'NOT_FOUND'

for fixture in 'private.debug_menu_experience_e2e()' \
  'public.continuity_rehearsal_export_chunk(uuid,integer,integer,text)'; do
  present="$(query "select to_regprocedure('$fixture') is not null;")"
  if [[ "$present" != 'f' ]]; then
    echo 'RPC_SECURITY_GATE=FAIL_DEBUG_OR_REHEARSAL_ENTRYPOINT_EXPOSED'
    exit 1
  fi
done
echo 'PRIVILEGED_TEST_HELPERS_EXCLUDED=PASSED'
echo 'ISOLATED_RPC_SECURITY_GATE=PASSED'
