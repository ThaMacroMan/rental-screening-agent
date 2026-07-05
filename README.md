# Screening Agent

Automated tenant screening phone interviews for rental inquiries. The agent places or receives calls through Twilio, conducts a structured conversation with OpenAI Realtime, persists screening state with tool calls, emails a summary to the property owner, and exposes a dashboard plus MCP tools for reviewing runs.

## What it does

When a prospect inquiry comes in, the system can trigger an outbound screening call. Over the phone, the agent:

1. Confirms **employment and income**
2. Confirms **move-in timeline and lease preferences**
3. Confirms **rental history and references**

The conversation stays friendly and natural, but the workflow is structured: the model uses tools to record partial or complete answers against each goal. When the call finishes, the owner receives an email summary. Runs are logged and viewable in a built-in dashboard or through MCP-connected assistants (Claude, ChatGPT, etc.).

## Architecture

```
Prospect phone
    │
    ▼
Twilio (Media Streams)
    │  WebSocket audio (μ-law)
    ▼
voice-bridge.js
    ├── OpenAI Realtime (gpt-realtime) — live speech + tool calls
    ├── Persistent state (.runtime/ or /data on Fly)
    ├── NDJSON event log
    ├── Dashboard + test-call UI
    ├── Summary email (SMTP)
    └── MCP HTTP endpoint (/mcp)
```

**Agentic loop:** the Realtime model speaks with the caller and invokes structured tools:

- `record_screening_update` — save progress on a screening goal
- `finish_screening` — close the call with a disposition (`complete`, `needs_review`, `unable_to_complete`)

Application code owns state, not the model transcript alone.

## Prerequisites

- Node.js 22+
- Twilio account with a voice-capable phone number
- OpenAI API key with Realtime access
- Public HTTPS URL for Twilio webhooks (ngrok for local dev, Fly.io in production)
- SMTP credentials (optional, for summary emails)

## Quick start (local)

```bash
npm install
# Create a .env file with the required variables listed below
npm run start:prod
```

`start-production.sh` loads `.env`, starts the voice bridge, and can auto-start an ngrok tunnel when `APP_BASE_URL` is not set to a public URL.

For local Twilio webhook testing, set `APP_BASE_URL` to your ngrok HTTPS URL or let the script discover it automatically (`NGROK_AUTOSTART=true` by default).

## Environment variables

### Required

| Variable             | Description                |
| -------------------- | -------------------------- |
| `OPENAI_API_KEY`     | OpenAI API key             |
| `TWILIO_ACCOUNT_SID` | Twilio account SID         |
| `TWILIO_AUTH_TOKEN`  | Twilio auth token          |
| `TWILIO_FROM_NUMBER` | Outbound caller ID (E.164) |

### Recommended

| Variable                                              | Description                                             |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `APP_BASE_URL`                                        | Public HTTPS base URL (e.g. `https://your-app.fly.dev`) |
| `DASHBOARD_USERNAME`                                  | Basic auth username for `/dashboard`                    |
| `DASHBOARD_PASSWORD`                                  | Basic auth password for `/dashboard`                    |
| `SUMMARY_EMAIL_TO`                                    | Recipient for completed screening summaries             |
| `SUMMARY_EMAIL_FROM`                                  | From address for summary emails                         |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP settings (or use `SMTP_URL`)                       |
| `MCP_BEARER_TOKEN`                                    | Enables OAuth-protected `/mcp` endpoint                 |

### Voice tuning

| Variable                              | Default        | Description                        |
| ------------------------------------- | -------------- | ---------------------------------- |
| `OPENAI_REALTIME_MODEL`               | `gpt-realtime` | Realtime model                     |
| `OPENAI_REALTIME_VOICE`               | `marin`        | Spoken voice                       |
| `OPENAI_REALTIME_SILENCE_DURATION_MS` | `300`          | Silence before end-of-turn         |
| `OPENAI_REALTIME_PREFIX_PADDING_MS`   | `300`          | Audio padding before speech        |
| `OPENAI_REALTIME_IDLE_TIMEOUT_MS`     | `5000`         | Idle timeout                       |
| `OPENAI_REALTIME_RESPONSE_DELAY_MS`   | `2200`         | Debounce before agent responds     |
| `VALIDATE_TWILIO_WEBHOOKS`            | `true`         | Validate Twilio request signatures |

See `fly.toml` for production defaults.

## Deployment (Fly.io)

The app is configured for Fly.io with a persistent volume at `/data` for runtime state and logs.

```bash
fly deploy
fly secrets set OPENAI_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_FROM_NUMBER=...
```

Health check: `GET /health`

## HTTP routes

| Route                                   | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `GET /health`                           | Service health and config snapshot          |
| `POST /voice/start`                     | Twilio webhook — starts a screening call    |
| `WS /voice/stream`                      | Twilio Media Streams WebSocket              |
| `GET /dashboard`                        | Ops dashboard (basic auth)                  |
| `GET /dashboard/api/runs`               | List screening runs                         |
| `GET /dashboard/api/runs/:callSid`      | Run detail                                  |
| `GET /dashboard/api/runs/:callSid/logs` | Event log for a run                         |
| `POST /testing/start`                   | Start a test outbound call                  |
| `POST /mcp`                             | MCP server (when `MCP_BEARER_TOKEN` is set) |

## MCP

### HTTP MCP (built into voice bridge)

When `MCP_BEARER_TOKEN` and `APP_BASE_URL` are set, the app exposes an OAuth-protected MCP endpoint at `/mcp` with tools to:

- `list_calls` — recent screening calls
- `get_call_transcript` — full turn-by-turn transcript
- `get_call_events` — raw runtime events
- `search_transcripts` — search across all calls

Connect from Claude Desktop, ChatGPT, or other MCP clients using your app URL as the issuer.

### Stdio MCP (Twilio call control)

`tenant-screening-mcp.js` is a separate stdio MCP server for starting and monitoring screening calls from an assistant:

```bash
./start-mcp-server.sh
```

Tools: `start_tenant_screening_call`, `get_call_status`, `end_call`

Requires `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` in `.env`.

## Project layout

```
voice-bridge.js          Main app: Twilio + OpenAI Realtime + dashboard + MCP
tenant-screening-mcp.js  Stdio MCP server for outbound call control
mcp-oauth.js             OAuth store and routes for HTTP MCP
mcp-auth-proxy.js        Local proxy helper
start-production.sh      Local/prod startup script
start-mcp-server.sh      Stdio MCP launcher
fly.toml                 Fly.io configuration
Dockerfile                 Production container
.runtime/                Local persistent state (gitignored)
```

## Development notes

- State is stored in `tenant-screening-state.json` and events in `voice-run-events.ndjson`.
- The dashboard includes a test-call form for quick manual verification.
- Phone-specific behavior (debounce, barge-in, voicemail detection, incomplete transcript handling) lives in `voice-bridge.js` alongside the Realtime session config.

## License

ISC
