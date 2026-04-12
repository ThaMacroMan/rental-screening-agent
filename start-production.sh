#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_PORT="${MCP_PORT:-8000}"
VOICE_PORT="${VOICE_PORT:-8002}"
PROXY_PORT="${PROXY_PORT:-${PORT:-8080}}"
RUNTIME_DIR="${RUNTIME_DIR:-/data}"
RUNTIME_FILE="${VOICE_RUNTIME_PATH:-${RUNTIME_DIR}/runtime.json}"
STATE_FILE="${VOICE_STATE_PATH:-${RUNTIME_DIR}/tenant-screening-state.json}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

if [ -z "$PUBLIC_BASE_URL" ] && [ -n "${FLY_APP_NAME:-}" ]; then
  PUBLIC_BASE_URL="https://${FLY_APP_NAME}.fly.dev"
fi

if [ -z "$PUBLIC_BASE_URL" ]; then
  echo "Missing PUBLIC_BASE_URL. Set it to your public app base URL, for example https://voice.example.com"
  exit 1
fi

mkdir -p "$RUNTIME_DIR"

export MCP_PORT
export VOICE_PORT
export PROXY_PORT
export VOICE_RUNTIME_PATH="$RUNTIME_FILE"
export VOICE_STATE_PATH="$STATE_FILE"
export VOICE_PUBLIC_BASE_URL="$PUBLIC_BASE_URL"

node - "$RUNTIME_FILE" "$PUBLIC_BASE_URL" <<'NODE'
const fs = require('fs');
const path = require('path');

const runtimeFile = process.argv[2];
const publicBaseUrl = process.argv[3].replace(/\/$/, '');

fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
fs.writeFileSync(runtimeFile, `${JSON.stringify({
  publicBaseUrl,
  mcpUrl: `${publicBaseUrl}/mcp`,
  voiceStartUrl: `${publicBaseUrl}/voice/start`,
  voiceTurnUrl: `${publicBaseUrl}/voice/turn`,
  voiceStateUrl: `${publicBaseUrl}/voice/state`,
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`);
NODE

cleanup() {
  kill "${MCP_PID:-}" "${PROXY_PID:-}" "${VOICE_PID:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Starting tenant screening MCP server on port ${MCP_PORT}..."
"$ROOT_DIR/node_modules/.bin/supergateway" \
  --port "${MCP_PORT}" \
  --outputTransport streamableHttp \
  --stdio "node ${ROOT_DIR}/tenant-screening-mcp.js" &
MCP_PID=$!

echo "Starting voice bridge on port ${VOICE_PORT}..."
node "$ROOT_DIR/voice-bridge.js" &
VOICE_PID=$!

echo "Starting proxy on port ${PROXY_PORT}..."
node "$ROOT_DIR/mcp-auth-proxy.js" &
PROXY_PID=$!

wait -n "$MCP_PID" "$VOICE_PID" "$PROXY_PID"
