#!/bin/bash

set -a
source "$(dirname "$0")/.env"
set +a

UPSTREAM_PORT=8000
PROXY_PORT=8001
VOICE_PORT=8002
RUNTIME_DIR="$(dirname "$0")/.runtime"
RUNTIME_FILE="${RUNTIME_DIR}/runtime.json"

mkdir -p "$RUNTIME_DIR"

export VOICE_RUNTIME_PATH="${VOICE_RUNTIME_PATH:-$RUNTIME_FILE}"
export VOICE_STATE_PATH="${VOICE_STATE_PATH:-${RUNTIME_DIR}/tenant-screening-state.json}"

cleanup_leftovers() {
  local port_pids
  port_pids=$(lsof -tiTCP:${UPSTREAM_PORT} -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$port_pids" ]; then
    echo "Stopping existing process on port ${UPSTREAM_PORT}: $port_pids"
    kill $port_pids 2>/dev/null || true
    sleep 2
  fi

  port_pids=$(lsof -tiTCP:${PROXY_PORT} -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$port_pids" ]; then
    echo "Stopping existing process on port ${PROXY_PORT}: $port_pids"
    kill $port_pids 2>/dev/null || true
    sleep 2
  fi

  port_pids=$(lsof -tiTCP:${VOICE_PORT} -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$port_pids" ]; then
    echo "Stopping existing process on port ${VOICE_PORT}: $port_pids"
    kill $port_pids 2>/dev/null || true
    sleep 2
  fi

  pkill -f 'ngrok http 8001' 2>/dev/null || true
  pkill -f 'supergateway.*--port 8000' 2>/dev/null || true
  pkill -f 'mcp-auth-proxy.js' 2>/dev/null || true
  pkill -f 'tenant-screening-mcp.js' 2>/dev/null || true
  pkill -f 'voice-bridge.js' 2>/dev/null || true
}

read_ngrok_url() {
  python3 - <<'PY'
import json
from pathlib import Path

log_path = Path("/tmp/ngrok-mcp.log")
if not log_path.exists():
    raise SystemExit(1)

allowed_suffixes = (".ngrok-free.app", ".ngrok.app", ".ngrok.io")

for line in log_path.read_text().splitlines():
    try:
        obj = json.loads(line)
    except Exception:
        continue

    url = obj.get("url")
    if (
        isinstance(url, str)
        and url.startswith("https://")
        and any(url.endswith(suffix) or suffix in url for suffix in allowed_suffixes)
    ):
        print(url)
        raise SystemExit(0)

raise SystemExit(1)
PY
}

cleanup_leftovers

if [ -z "${MCP_BEARER_TOKEN:-}" ]; then
  echo "Missing MCP_BEARER_TOKEN in .env"
  exit 1
fi

echo "Starting tenant screening MCP server on port 8000..."
npx -y supergateway \
  --port "${UPSTREAM_PORT}" \
  --outputTransport streamableHttp \
  --stdio "node $(dirname "$0")/tenant-screening-mcp.js" &
MCP_PID=$!

sleep 3

echo "Starting proxy on port 8001..."
node "$(dirname "$0")/mcp-auth-proxy.js" &
PROXY_PID=$!

sleep 1

echo "Starting voice bridge on port 8002..."
node "$(dirname "$0")/voice-bridge.js" &
VOICE_PID=$!

sleep 1

echo "Starting ngrok tunnel..."
ngrok http "${PROXY_PORT}" --inspect=false --log=stdout --log-format=json > /tmp/ngrok-mcp.log 2>&1 &
NGROK_PID=$!

sleep 3

NGROK_URL=""
for _ in {1..10}; do
  NGROK_URL=$(read_ngrok_url 2>/dev/null || true)
  if [ -n "$NGROK_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$NGROK_URL" ]; then
  echo "Failed to read ngrok public URL from /tmp/ngrok-mcp.log"
  echo "ngrok log follows:"
  cat /tmp/ngrok-mcp.log
  exit 1
fi

python3 - "$RUNTIME_FILE" "$NGROK_URL" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

runtime_file = Path(sys.argv[1])
public_base_url = sys.argv[2].rstrip('/')
payload = {
    "publicBaseUrl": public_base_url,
    "appBaseUrl": public_base_url,
    "mcpUrl": f"{public_base_url}/mcp",
    "voiceStartUrl": f"{public_base_url}/voice/start",
    "voiceTurnUrl": f"{public_base_url}/voice/turn",
    "voiceStateUrl": f"{public_base_url}/voice/state",
    "updatedAt": datetime.now(timezone.utc).isoformat(),
}
runtime_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

export VOICE_PUBLIC_BASE_URL="$NGROK_URL"
export APP_BASE_URL="$NGROK_URL"
export VOICE_MCP_URL="${NGROK_URL}/mcp"
export VOICE_START_URL="${NGROK_URL}/voice/start"
export VOICE_TURN_URL="${NGROK_URL}/voice/turn"
export VOICE_STATE_URL="${NGROK_URL}/voice/state"

echo ""
echo "============================================"
echo "  Tenant screening MCP server is live!"
echo ""
echo "  MCP Server URL : $NGROK_URL/mcp"
echo "============================================"
echo ""
echo "Press Ctrl+C to stop all services."

trap "kill $MCP_PID $PROXY_PID $VOICE_PID $NGROK_PID 2>/dev/null; exit" INT TERM
wait
