#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$HOME/plateform}"
REPLICA_ROOT="${2:-}"
PRIMARY_ROOT="$HOME/.local/share/plateform/backups"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
PLATEFORM_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/plateform"
ENV_FILE="$PLATEFORM_CONFIG_DIR/continuity.env"
TOOLCHAIN_ENV_FILE="$PLATEFORM_CONFIG_DIR/toolchain.env"

if [[ ! -f "$ROOT_DIR/package.json" || ! -f "$ROOT_DIR/tools/backup-worker/start.mjs" ]]; then
  echo "Plateform repository not found at: $ROOT_DIR" >&2
  exit 2
fi
if [[ -n "$REPLICA_ROOT" && "$REPLICA_ROOT" != /* ]]; then
  echo "Replica root must be an absolute path on an independent filesystem/mount." >&2
  exit 2
fi
if [[ -n "$REPLICA_ROOT" && "$REPLICA_ROOT" =~ [[:space:]] ]]; then
  echo "Replica root must not contain whitespace." >&2
  exit 2
fi

mkdir -p "$USER_SYSTEMD_DIR" "$PLATEFORM_CONFIG_DIR" "$PRIMARY_ROOT"
chmod 700 "$PLATEFORM_CONFIG_DIR" "$PRIMARY_ROOT"
if [[ -n "$REPLICA_ROOT" ]]; then
  mkdir -p "$REPLICA_ROOT"
  chmod 700 "$REPLICA_ROOT"
fi

cp "$ROOT_DIR/deploy/continuity/plateform-backup-worker.service" "$USER_SYSTEMD_DIR/plateform-backup-worker.service"
cp "$ROOT_DIR/deploy/continuity/plateform-backup-worker.timer" "$USER_SYSTEMD_DIR/plateform-backup-worker.timer"
cp "$ROOT_DIR/deploy/continuity/plateform-backup-retention-worker.service" "$USER_SYSTEMD_DIR/plateform-backup-retention-worker.service"
cp "$ROOT_DIR/deploy/continuity/plateform-backup-retention-worker.timer" "$USER_SYSTEMD_DIR/plateform-backup-retention-worker.timer"

if [[ ! -e "$ENV_FILE" ]]; then
  replica_value="${REPLICA_ROOT:-REPLACE_WITH_INDEPENDENT_ABSOLUTE_PATH}"
  awk -v primary="$PRIMARY_ROOT" -v replica="$replica_value" '
    /^PLATEFORM_BACKUP_ROOT=/ { print "PLATEFORM_BACKUP_ROOT=" primary; next }
    /^PLATEFORM_BACKUP_REPLICA_ROOT=/ { print "PLATEFORM_BACKUP_REPLICA_ROOT=" replica; next }
    { print }
  ' "$ROOT_DIR/deploy/continuity/continuity.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE from template. Fill secrets before enabling timers."
else
  chmod 600 "$ENV_FILE"
  echo "Preserved existing $ENV_FILE."
fi

for unit in plateform-backup-worker.service plateform-backup-retention-worker.service; do
  dropin="$USER_SYSTEMD_DIR/${unit}.d"
  mkdir -p "$dropin"
  cat > "$dropin/toolchain.conf" <<DROPIN
[Service]
EnvironmentFile=-$TOOLCHAIN_ENV_FILE
DROPIN
  if [[ -n "$REPLICA_ROOT" ]]; then
    cat > "$dropin/storage.conf" <<DROPIN
[Service]
ReadWritePaths=$REPLICA_ROOT
DROPIN
  else
    rm -f "$dropin/storage.conf"
  fi
done

systemctl --user daemon-reload
cat <<MSG
Installed user units.
Primary backup root: $PRIMARY_ROOT
Replica backup root: ${REPLICA_ROOT:-NOT CONFIGURED}

Next steps:
  0. If $TOOLCHAIN_ENV_FILE does not exist yet, run:
       deploy/continuity/bootstrap-user-toolchain.sh "$ROOT_DIR"
  1. Ensure the replica root is an independent filesystem/device or remote mount.
     If not configured, rerun:
       deploy/continuity/install-user-service.sh "$ROOT_DIR" "/absolute/independent/replica/path"
  2. Edit $ENV_FILE and replace every REPLACE_* placeholder.
  3. From $ROOT_DIR run: npm run continuity:host-check
  4. Run: npm run backup:check
  5. Run: npm run retention:check
  6. Only after all checks are READY:
     systemctl --user enable --now plateform-backup-worker.timer plateform-backup-retention-worker.timer
MSG
