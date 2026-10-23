#!/usr/bin/env bash
# Deploys supabase/functions/* to a disposable STAGING project through the
# Supabase Management API (the caller supplies auth, e.g. a proxy-injected
# personal access token). verify_jwt comes from supabase/config.toml.
#   PLATEFORM_STAGING_REF=<ref> tools/staging-api/deploy_functions.sh [name...]
set -euo pipefail
REF="${PLATEFORM_STAGING_REF:-}"
if [[ ! "$REF" =~ ^[a-z0-9]{20}$ || "$REF" == abdxvlykasqmknexxhjo ]]; then
  echo 'PLATEFORM_STAGING_REF must name a disposable staging project' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  mapfile -t names < <(find supabase/functions -mindepth 1 -maxdepth 1 -type d ! -name '_*' -printf '%f\n' | sort)
fi
fail=0
for n in "${names[@]}"; do
  verify=$(awk -v s="[functions.$n]" '$0==s{f=1;next} /^\[/{f=0} f&&/^verify_jwt/{print $3}' supabase/config.toml)
  verify="${verify:-true}"
  args=()
  for f in $(python3 tools/staging-api/imports.py "supabase/functions/$n/index.ts"); do args+=(-F "file=@$f;filename=$f"); done
  meta=$(printf '{"entrypoint_path":"supabase/functions/%s/index.ts","name":"%s","verify_jwt":%s}' "$n" "$n" "$verify")
  out=$(curl -sS -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=$n" \
    -F "metadata=$meta;type=application/json" "${args[@]}")
  if echo "$out" | grep -q '"status":"ACTIVE"'; then echo "DEPLOYED $n verify_jwt=$verify"; else echo "FAILED $n: ${out:0:400}"; fail=1; fi
  sleep 1
done
exit $fail
