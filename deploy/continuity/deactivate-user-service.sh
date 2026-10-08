#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now plateform-backup-worker.timer plateform-backup-retention-worker.timer
printf '%s\n' '{"status":"DISABLED"}'
