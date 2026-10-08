#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$HOME/plateform}"
LOCK_FILE="$ROOT_DIR/deploy/continuity/toolchain.lock.env"
LOCAL_BIN="$HOME/.local/bin"
LOCAL_OPT="$HOME/.local/opt"
LOCAL_SHARE="$HOME/.local/share/plateform"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/plateform"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "Continuity toolchain lock not found: $LOCK_FILE" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "$LOCK_FILE"
: "${PLATEFORM_CONTINUITY_NODE_VERSION:?missing pinned Node version}"
: "${PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION:?missing pinned Supabase CLI version}"
: "${PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR:?missing minimum psql major}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This bootstrap supports Linux continuity hosts only." >&2
  exit 2
fi

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 2 ;;
esac

for bin in curl sha256sum tar xz; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "Missing system prerequisite: $bin" >&2
    exit 2
  fi
done

mkdir -p "$LOCAL_BIN" "$LOCAL_OPT" "$LOCAL_SHARE" "$CONFIG_DIR"
chmod 700 "$LOCAL_BIN" "$LOCAL_OPT" "$LOCAL_SHARE" "$CONFIG_DIR"

NODE_DIST="node-v${PLATEFORM_CONTINUITY_NODE_VERSION}-linux-${NODE_ARCH}"
NODE_HOME="$LOCAL_OPT/$NODE_DIST"
NODE_ARCHIVE="$NODE_DIST.tar.xz"
NODE_BASE="https://nodejs.org/download/release/v${PLATEFORM_CONTINUITY_NODE_VERSION}"

if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl --fail --silent --show-error --location "$NODE_BASE/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  curl --fail --silent --show-error --location "$NODE_BASE/$NODE_ARCHIVE" -o "$tmp/$NODE_ARCHIVE"
  expected="$(awk -v file="$NODE_ARCHIVE" '$2 == file {print $1}' "$tmp/SHASUMS256.txt")"
  if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Unable to resolve official Node SHA-256 for $NODE_ARCHIVE" >&2
    exit 2
  fi
  actual="$(sha256sum "$tmp/$NODE_ARCHIVE" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Node archive checksum mismatch." >&2
    exit 2
  fi
  rm -rf "$NODE_HOME"
  tar -xJf "$tmp/$NODE_ARCHIVE" -C "$LOCAL_OPT"
  rm -rf "$tmp"
  trap - EXIT
fi

for bin in node npm npx corepack; do
  ln -sfn "$NODE_HOME/bin/$bin" "$LOCAL_BIN/$bin"
done

NODE_ACTUAL="$($LOCAL_BIN/node --version)"
if [[ "$NODE_ACTUAL" != "v${PLATEFORM_CONTINUITY_NODE_VERSION}" ]]; then
  echo "Pinned Node verification failed: $NODE_ACTUAL" >&2
  exit 2
fi

CLI_HOME="$LOCAL_SHARE/supabase-cli-${PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION}"
if [[ ! -x "$CLI_HOME/node_modules/.bin/supabase" ]]; then
  rm -rf "$CLI_HOME"
  mkdir -p "$CLI_HOME"
  cat > "$CLI_HOME/package.json" <<JSON
{"name":"plateform-continuity-cli","private":true,"dependencies":{"supabase":"${PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION}"}}
JSON
  PATH="$LOCAL_BIN:/usr/local/bin:/usr/bin:/bin" "$LOCAL_BIN/npm" install \
    --prefix "$CLI_HOME" --omit=dev --no-audit --no-fund --save-exact
fi
ln -sfn "$CLI_HOME/node_modules/.bin/supabase" "$LOCAL_BIN/supabase"

CLI_ACTUAL="$(PATH="$LOCAL_BIN:/usr/local/bin:/usr/bin:/bin" "$LOCAL_BIN/supabase" --version | tr -d '\r')"
if [[ "$CLI_ACTUAL" != "$PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION" ]]; then
  echo "Pinned Supabase CLI verification failed: expected $PLATEFORM_CONTINUITY_SUPABASE_CLI_VERSION, got $CLI_ACTUAL" >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  cat >&2 <<MSG
Missing system prerequisite: psql.
Install the PostgreSQL client from your distribution/package repository, then rerun this bootstrap.
Required minimum major: ${PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR}.
MSG
  exit 2
fi
PSQL_MAJOR="$(psql --version | sed -E 's/.* ([0-9]+)(\..*)?$/\1/')"
if [[ ! "$PSQL_MAJOR" =~ ^[0-9]+$ ]] || (( PSQL_MAJOR < PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR )); then
  echo "psql major $PSQL_MAJOR is below required ${PLATEFORM_CONTINUITY_MIN_PSQL_MAJOR}." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Missing system prerequisite: docker.
Install Docker Engine plus the rootless extras package. Do not grant the continuity user access to a rootful Docker socket.
MSG
  exit 2
fi

if ! command -v newuidmap >/dev/null 2>&1 || ! command -v newgidmap >/dev/null 2>&1; then
  echo "Missing rootless Docker prerequisite: newuidmap/newgidmap (usually the uidmap package)." >&2
  exit 2
fi

user_name="$(id -un)"
if ! grep -q "^${user_name}:.*:[6-9][0-9][0-9][0-9][0-9]$\|^${user_name}:[0-9]\+:[0-9]\{5,\}$" /etc/subuid 2>/dev/null \
   || ! grep -q "^${user_name}:.*:[6-9][0-9][0-9][0-9][0-9]$\|^${user_name}:[0-9]\+:[0-9]\{5,\}$" /etc/subgid 2>/dev/null; then
  echo "Rootless Docker requires subordinate UID/GID ranges for ${user_name} in /etc/subuid and /etc/subgid." >&2
  exit 2
fi

DOCKER_HOST_VALUE="unix:///run/user/$(id -u)/docker.sock"
export DOCKER_HOST="$DOCKER_HOST_VALUE"
if ! docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -qi rootless; then
  if ! command -v dockerd-rootless-setuptool.sh >/dev/null 2>&1; then
    echo "Rootless Docker is not ready and dockerd-rootless-setuptool.sh is unavailable. Install Docker rootless extras." >&2
    exit 2
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is required for the supported continuity-host rootless Docker setup." >&2
    exit 2
  fi
  dockerd-rootless-setuptool.sh install
  systemctl --user enable --now docker.service
fi

security_options="$(docker info --format '{{json .SecurityOptions}}')"
if ! grep -qi rootless <<<"$security_options"; then
  echo "Docker daemon is not rootless after setup." >&2
  exit 2
fi

cat > "$CONFIG_DIR/toolchain.env" <<ENV
PATH=$LOCAL_BIN:/usr/local/bin:/usr/bin:/bin
DOCKER_HOST=$DOCKER_HOST_VALUE
SUPABASE_CLI_BIN=$LOCAL_BIN/supabase
PSQL_BIN=$(command -v psql)
DOCKER_BIN=$(command -v docker)
ENV
chmod 600 "$CONFIG_DIR/toolchain.env"

cat <<MSG
Plateform continuity user toolchain is READY.
Node: $NODE_ACTUAL
Supabase CLI: $CLI_ACTUAL
psql: $(psql --version)
Docker: rootless
Toolchain environment: $CONFIG_DIR/toolchain.env

Next:
  deploy/continuity/install-user-service.sh "$ROOT_DIR" "/absolute/independent/replica/path"
  edit $CONFIG_DIR/continuity.env
  npm run continuity:host-check
MSG
