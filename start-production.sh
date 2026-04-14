#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRESET_APP_BASE_URL="${APP_BASE_URL-}"
PRESET_RUNTIME_DIR="${RUNTIME_DIR-}"
PRESET_VOICE_PORT="${VOICE_PORT-}"
PRESET_PROXY_PORT="${PROXY_PORT-}"
PRESET_VOICE_RUNTIME_PATH="${VOICE_RUNTIME_PATH-}"
PRESET_VOICE_STATE_PATH="${VOICE_STATE_PATH-}"
PRESET_VOICE_PUBLIC_BASE_URL="${VOICE_PUBLIC_BASE_URL-}"
AUTO_NGROK="${NGROK_AUTOSTART:-true}"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  . "$ROOT_DIR/.env"
  set +a
fi

if [ -n "$PRESET_APP_BASE_URL" ]; then
  APP_BASE_URL="$PRESET_APP_BASE_URL"
fi
if [ -n "$PRESET_RUNTIME_DIR" ]; then
  RUNTIME_DIR="$PRESET_RUNTIME_DIR"
fi
if [ -n "$PRESET_VOICE_PORT" ]; then
  VOICE_PORT="$PRESET_VOICE_PORT"
fi
if [ -n "$PRESET_PROXY_PORT" ]; then
  PROXY_PORT="$PRESET_PROXY_PORT"
fi
if [ -n "$PRESET_VOICE_RUNTIME_PATH" ]; then
  VOICE_RUNTIME_PATH="$PRESET_VOICE_RUNTIME_PATH"
fi
if [ -n "$PRESET_VOICE_STATE_PATH" ]; then
  VOICE_STATE_PATH="$PRESET_VOICE_STATE_PATH"
fi
if [ -n "$PRESET_VOICE_PUBLIC_BASE_URL" ]; then
  VOICE_PUBLIC_BASE_URL="$PRESET_VOICE_PUBLIC_BASE_URL"
fi

VOICE_PORT="${VOICE_PORT:-8002}"
PROXY_PORT="${PROXY_PORT:-${PORT:-8080}}"
export VOICE_PORT
export PROXY_PORT

if [ -z "${RUNTIME_DIR:-}" ]; then
  if [ -d /data ] && mkdir -p /data 2>/dev/null && [ -w /data ]; then
    RUNTIME_DIR="/data"
  else
    RUNTIME_DIR="${ROOT_DIR}/.runtime"
  fi
fi
RUNTIME_FILE="${VOICE_RUNTIME_PATH:-${RUNTIME_DIR}/runtime.json}"
STATE_FILE="${VOICE_STATE_PATH:-${RUNTIME_DIR}/tenant-screening-state.json}"
APP_BASE_URL="${APP_BASE_URL:-}"

if [ -z "$APP_BASE_URL" ] && [ -n "${FLY_APP_NAME:-}" ]; then
  APP_BASE_URL="https://${FLY_APP_NAME}.fly.dev"
fi

is_local_base_url() {
  local value="${1:-}"
  case "$value" in
    http://localhost:*|https://localhost:*|http://127.0.0.1:*|https://127.0.0.1:*)
      return 0
      ;;
  esac

  return 1
}

is_fly_dev_base_url() {
  local value="${1:-}"
  case "$value" in
    http://*.fly.dev|https://*.fly.dev)
      return 0
      ;;
  esac

  return 1
}

read_ngrok_url() {
  python3 - <<'PY'
import json
import sys
from urllib.request import urlopen

try:
    with urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1) as response:
        payload = json.load(response)
except Exception:
    raise SystemExit(1)

allowed_suffixes = (".ngrok-free.app", ".ngrok.app", ".ngrok.io")
for tunnel in payload.get("tunnels", []):
    url = tunnel.get("public_url")
    if (
        isinstance(url, str)
        and url.startswith("https://")
        and any(suffix in url for suffix in allowed_suffixes)
    ):
        print(url.rstrip("/"))
        raise SystemExit(0)

raise SystemExit(1)
PY
}

cleanup() {
  kill "${PROXY_PID:-}" "${VOICE_PID:-}" "${NGROK_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

port_listener_pid() {
  local port="${1:-}"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

reclaim_repo_listener() {
  local port="${1:-}"
  local marker="${2:-}"
  local pid=""
  local cmd=""

  pid="$(port_listener_pid "$port" || true)"
  if [ -z "$pid" ]; then
    return 0
  fi

  cmd="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^ *//')"
  if [[ "$cmd" == *"$marker"* ]]; then
    echo "Stopping stale $marker on port ${port} (pid ${pid})..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      if ! kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
    return 0
  fi

  echo "Port ${port} is already in use by: ${cmd}"
  exit 1
}

write_runtime_config() {
  node - "$RUNTIME_FILE" "$APP_BASE_URL" <<'NODE'
const fs = require('fs');
const path = require('path');

const runtimeFile = process.argv[2];
const appBaseUrl = process.argv[3].replace(/\/$/, '');

fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
fs.writeFileSync(runtimeFile, `${JSON.stringify({
  appBaseUrl,
  publicBaseUrl: appBaseUrl,
  voiceStartUrl: `${appBaseUrl}/voice/start`,
  voiceStateUrl: `${appBaseUrl}/voice/state`,
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`);
NODE
}

reclaim_repo_listener "$PROXY_PORT" "mcp-auth-proxy.js"
reclaim_repo_listener "$VOICE_PORT" "voice-bridge.js"

if [ -z "$APP_BASE_URL" ] || is_local_base_url "$APP_BASE_URL" || { [ -z "${FLY_APP_NAME:-}" ] && is_fly_dev_base_url "$APP_BASE_URL"; }; then
  if [ "$AUTO_NGROK" != "true" ]; then
    echo "Missing public APP_BASE_URL. Set it to a public HTTPS URL or enable ngrok with NGROK_AUTOSTART=true."
    exit 1
  fi

  if ! command -v ngrok >/dev/null 2>&1; then
    echo "ngrok is not installed. Install the ngrok CLI or set APP_BASE_URL to a public HTTPS URL."
    exit 1
  fi

  mkdir -p "$RUNTIME_DIR"

  echo "Starting proxy on port ${PROXY_PORT}..."
  node "$ROOT_DIR/mcp-auth-proxy.js" &
  PROXY_PID=$!

  sleep 1

  echo "Starting ngrok tunnel for port ${PROXY_PORT}..."
  ngrok http "${PROXY_PORT}" --inspect=false --log=stdout --log-format=json > /tmp/voice-ngrok.log 2>&1 &
  NGROK_PID=$!

  NGROK_URL=""
  for _ in $(seq 1 20); do
    NGROK_URL=$(read_ngrok_url 2>/dev/null || true)
    if [ -n "$NGROK_URL" ]; then
      break
    fi

    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
      echo "ngrok exited early."
      echo "ngrok log follows:"
      cat /tmp/voice-ngrok.log
      exit 1
    fi

    sleep 1
  done

  if [ -z "$NGROK_URL" ]; then
    echo "Failed to read ngrok public URL."
    echo "ngrok log follows:"
    cat /tmp/voice-ngrok.log
    exit 1
  fi

  APP_BASE_URL="$NGROK_URL"
  export APP_BASE_URL="$APP_BASE_URL"
  export VOICE_RUNTIME_PATH="$RUNTIME_FILE"
  export VOICE_STATE_PATH="$STATE_FILE"
  export VOICE_PUBLIC_BASE_URL="$APP_BASE_URL"
  write_runtime_config

  echo "Starting voice bridge on port ${VOICE_PORT}..."
  node "$ROOT_DIR/voice-bridge.js" &
  VOICE_PID=$!
else
  mkdir -p "$RUNTIME_DIR"
  export APP_BASE_URL="$APP_BASE_URL"
  export VOICE_RUNTIME_PATH="$RUNTIME_FILE"
  export VOICE_STATE_PATH="$STATE_FILE"
  export VOICE_PUBLIC_BASE_URL="$APP_BASE_URL"
  write_runtime_config

  echo "Starting proxy on port ${PROXY_PORT}..."
  node "$ROOT_DIR/mcp-auth-proxy.js" &
  PROXY_PID=$!

  echo "Starting voice bridge on port ${VOICE_PORT}..."
  node "$ROOT_DIR/voice-bridge.js" &
  VOICE_PID=$!
fi

while true; do
  if ! kill -0 "$VOICE_PID" 2>/dev/null; then
    wait "$VOICE_PID" 2>/dev/null || true
    break
  fi

  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    wait "$PROXY_PID" 2>/dev/null || true
    break
  fi

  sleep 1
done
