#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$HOME/plateform}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/plateform"
ENV_FILE="$CONFIG_DIR/continuity.env"

if [[ ! -f "$ROOT_DIR/tools/backup-worker/config.mjs" ]]; then
  echo "Plateform repository not found at: $ROOT_DIR" >&2
  exit 2
fi

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
umask 077

existing_value() {
  local name="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$name" '$1==key {sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE"
}

primary="$(existing_value PLATEFORM_BACKUP_ROOT)"
replica="$(existing_value PLATEFORM_BACKUP_REPLICA_ROOT)"
[[ -n "$primary" && "$primary" != REPLACE_* ]] || primary="$HOME/.local/share/plateform/backups"
[[ -n "$replica" && "$replica" != REPLACE_* ]] || replica=""

read -r -p "Supabase project ref (Plateform source): " project_ref
if [[ ! "$project_ref" =~ ^[a-z0-9]{20}$ ]]; then
  echo "Invalid Supabase project ref." >&2
  exit 2
fi

read -r -s -p "Supabase server key (sb_secret_... or legacy service_role JWT): " server_key
echo
read -r -s -p "PostgreSQL direct/session-pooler URL for the same project: " database_url
echo
read -r -s -p "Backup encryption key (base64, exactly 32 bytes decoded): " encryption_key
echo
read -r -p "Backup encryption key ID [continuity-key-v1]: " encryption_key_id
encryption_key_id="${encryption_key_id:-continuity-key-v1}"

read -r -p "Primary backup root [$primary]: " primary_input
primary="${primary_input:-$primary}"
if [[ -z "$replica" ]]; then
  read -r -p "Independent replica root (absolute path): " replica
else
  read -r -p "Independent replica root [$replica]: " replica_input
  replica="${replica_input:-$replica}"
fi

if [[ "$primary" != /* || "$replica" != /* || "$primary" == "$replica" ]]; then
  echo "Primary and replica roots must be distinct absolute paths." >&2
  exit 2
fi
if [[ "$primary" =~ [[:space:]] || "$replica" =~ [[:space:]] ]]; then
  echo "Backup roots must not contain whitespace." >&2
  exit 2
fi
if [[ ! "$encryption_key_id" =~ ^[A-Za-z0-9._:-]{3,160}$ ]]; then
  echo "Invalid encryption key ID." >&2
  exit 2
fi

TMP_FILE="$(mktemp "$CONFIG_DIR/.continuity.env.XXXXXX")"
cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT
chmod 600 "$TMP_FILE"
cat > "$TMP_FILE" <<ENV
SUPABASE_URL=https://${project_ref}.supabase.co
SUPABASE_SERVICE_ROLE_KEY=${server_key}
SUPABASE_DB_URL=${database_url}
PLATEFORM_BACKUP_ROOT=${primary}
PLATEFORM_BACKUP_REPLICA_ROOT=${replica}
PLATEFORM_ALLOW_SAME_DEVICE_REPLICA=false
PLATEFORM_BACKUP_ENCRYPTION_KEY_BASE64=${encryption_key}
PLATEFORM_BACKUP_ENCRYPTION_KEY_ID=${encryption_key_id}
PLATEFORM_ALLOW_ROOTFUL_DOCKER=false
PLATEFORM_BACKUP_LEASE_SECONDS=1800
PLATEFORM_RETENTION_LEASE_SECONDS=300
ENV

# Validate the exact worker configuration before replacing the live env file.
(
  set -a
  # shellcheck disable=SC1090
  source "$TMP_FILE"
  set +a
  cd "$ROOT_DIR"
  node --input-type=module - <<'NODE'
import { loadConfig } from './tools/backup-worker/config.mjs';
const config=loadConfig();
console.log(JSON.stringify({status:'CONFIG_VALID',sourceProjectRef:config.sourceProjectRef,encryptionKeyId:config.encryptionKeyId}));
NODE
)

mv -f "$TMP_FILE" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"
unset server_key database_url encryption_key

echo "Wrote validated continuity configuration to $ENV_FILE (0600)."
echo "Next: deploy/continuity/activate-user-service.sh \"$ROOT_DIR\""
