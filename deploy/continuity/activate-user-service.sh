#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$HOME/plateform}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/plateform"
ENV_FILE="$CONFIG_DIR/continuity.env"
TOOLCHAIN_ENV_FILE="$CONFIG_DIR/toolchain.env"

if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  echo "Plateform repository not found at: $ROOT_DIR" >&2
  exit 2
fi
for file in "$ENV_FILE" "$TOOLCHAIN_ENV_FILE"; do
  if [[ ! -f "$file" ]]; then
    echo "Required environment file missing: $file" >&2
    exit 2
  fi
  mode="$(stat -c '%a' "$file")"
  if [[ "$mode" != "600" ]]; then
    echo "Unsafe permissions on $file: expected 600, got $mode" >&2
    exit 2
  fi
done

if grep -Eq '(^|=)(REPLACE_|REPLACE_WITH_|PROJECT_REF|DISPOSABLE_REF|REPLACEMENT_REF)' "$ENV_FILE"; then
  echo "continuity.env still contains placeholder values." >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$TOOLCHAIN_ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$ROOT_DIR"
node scripts/check-continuity-host.mjs
node tools/backup-worker/start.mjs --check
node tools/backup-retention-worker/start.mjs --check

systemctl --user daemon-reload
systemctl --user enable --now plateform-backup-worker.timer plateform-backup-retention-worker.timer

for timer in plateform-backup-worker.timer plateform-backup-retention-worker.timer; do
  if [[ "$(systemctl --user is-enabled "$timer")" != "enabled" ]]; then
    echo "Timer was not enabled: $timer" >&2
    exit 2
  fi
  state="$(systemctl --user is-active "$timer")"
  if [[ "$state" != "active" && "$state" != "waiting" ]]; then
    echo "Timer is not active: $timer ($state)" >&2
    exit 2
  fi
done

printf '%s\n' '{"status":"READY_AND_ENABLED","backup_timer":"enabled","retention_timer":"enabled"}'
