#!/usr/bin/env node

const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod/v4");
const { mountMcpOAuth } = require("./mcp-oauth.js");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const openaiApiKey = requiredEnv("OPENAI_API_KEY");
const twilioAuthToken = requiredEnv("TWILIO_AUTH_TOKEN");
const twilioAccountSid = requiredEnv("TWILIO_ACCOUNT_SID");
const twilioFromNumber = requiredEnv("TWILIO_FROM_NUMBER");
const defaultFromNumber = twilioFromNumber;
const openaiRealtimeModel = normalizeText(
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
);
const supportedOpenAIRealtimeVoices = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);
const openaiRealtimeVoiceFallback = "sage";
const requestedOpenAIRealtimeVoice = normalizeText(
  process.env.OPENAI_REALTIME_VOICE || openaiRealtimeVoiceFallback,
);
const openaiRealtimeVoice = supportedOpenAIRealtimeVoices.has(
  requestedOpenAIRealtimeVoice,
)
  ? requestedOpenAIRealtimeVoice
  : openaiRealtimeVoiceFallback;
if (requestedOpenAIRealtimeVoice !== openaiRealtimeVoice) {
  console.warn(
    `[voice-bridge] Invalid OPENAI_REALTIME_VOICE="${requestedOpenAIRealtimeVoice}" falling back to "${openaiRealtimeVoice}"`,
  );
}
const openaiRealtimeInputLanguage = normalizeText(
  process.env.OPENAI_REALTIME_INPUT_LANGUAGE || "en",
);

function readPositiveNumberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const openaiRealtimeIdleTimeoutMs = readPositiveNumberEnv(
  "OPENAI_REALTIME_IDLE_TIMEOUT_MS",
  5000,
);
const openaiRealtimeResponseTimeoutMs = readPositiveNumberEnv(
  "OPENAI_REALTIME_RESPONSE_TIMEOUT_MS",
  20000,
);
const openaiRealtimeSpeechThreshold = Number(
  process.env.OPENAI_REALTIME_SPEECH_THRESHOLD || 0.9,
);
const openaiRealtimeSilenceDurationMs = readPositiveNumberEnv(
  "OPENAI_REALTIME_SILENCE_DURATION_MS",
  500,
);
const openaiRealtimePrefixPaddingMs = readPositiveNumberEnv(
  "OPENAI_REALTIME_PREFIX_PADDING_MS",
  400,
);
const openaiRealtimeResponseDelayMs = readPositiveNumberEnv(
  "OPENAI_REALTIME_RESPONSE_DELAY_MS",
  2200,
);
const maxUnclearAttempts = readPositiveNumberEnv(
  "TWILIO_GATHER_MAX_UNCLEAR_ATTEMPTS",
  3,
);

const SCREENING_GOALS = [
  {
    key: "employment_income",
    label: "Employment and income",
    guidance:
      "Confirm current employment or income source and enough detail to judge rent affordability.",
  },
  {
    key: "move_in_timeline",
    label: "Move-in timeline and lease",
    guidance:
      "Confirm when they want to move in and what kind of lease term they want.",
  },
  {
    key: "rental_history_references",
    label: "Rental history and references",
    guidance:
      "Confirm recent rental history and whether they can provide landlord or character references.",
  },
];

const OPENAI_TOOLS = [
  {
    type: "function",
    name: "record_screening_update",
    description:
      "Record the caller answer for the current screening goal and decide whether it is partial or complete.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string",
          enum: SCREENING_GOALS.map((goal) => goal.key),
        },
        status: {
          type: "string",
          enum: ["open", "partial", "complete"],
        },
        notes: {
          type: "string",
        },
        captured_answer: {
          type: "string",
        },
        next_goal: {
          type: ["string", "null"],
          enum: [...SCREENING_GOALS.map((goal) => goal.key), null],
        },
      },
      required: ["goal", "status", "notes", "captured_answer"],
    },
  },
  {
    type: "function",
    name: "finish_screening",
    description:
      "Mark the screening as finished once all goals are complete or the caller is no longer suitable for automated screening.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
        },
        disposition: {
          type: "string",
          enum: ["complete", "needs_review", "unable_to_complete"],
        },
        flags: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["summary", "disposition"],
    },
  },
];

const runtimePath =
  process.env.VOICE_RUNTIME_PATH ||
  path.join(__dirname, ".runtime", "runtime.json");
const statePath =
  process.env.VOICE_STATE_PATH ||
  path.join(__dirname, ".runtime", "tenant-screening-state.json");
const eventLogPath =
  process.env.VOICE_EVENT_LOG_PATH ||
  path.join(path.dirname(statePath), "voice-run-events.ndjson");
const dashboardUsername = normalizeText(process.env.DASHBOARD_USERNAME);
const dashboardPassword = normalizeText(process.env.DASHBOARD_PASSWORD);
const appBaseUrl = (
  process.env.APP_BASE_URL ||
  process.env.PUBLIC_BASE_URL ||
  ""
).replace(/\/$/, "");
// Voice options for quick switching:
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna-Generative';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Google.en-US-Chirp3-HD-Aoede';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna-Neural';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna';
const defaultVoice = process.env.TWILIO_TTS_VOICE || "Polly.Joanna-Generative";
const fallbackVoice =
  process.env.TWILIO_TTS_VOICE_FALLBACK || "Polly.Joanna-Neural";
const selectedVoice =
  process.env.TWILIO_TTS_USE_FALLBACK === "true" ? fallbackVoice : defaultVoice;
const selectedLanguage = process.env.TWILIO_TTS_LANGUAGE || "en-US";
console.log(
  `[voice-bridge] Twilio TTS voice: ${selectedVoice} (fallback: ${fallbackVoice}, language: ${selectedLanguage})`,
);
const summaryEmailTo = process.env.SUMMARY_EMAIL_TO || "joshkuski@gmail.com";
const summaryEmailFrom =
  process.env.SUMMARY_EMAIL_FROM ||
  process.env.SMTP_FROM ||
  process.env.SMTP_USER ||
  "tenant-screening@localhost";
const smtpUrl = process.env.SMTP_URL || "";
const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = process.env.SMTP_PORT
  ? Number(process.env.SMTP_PORT)
  : undefined;
const smtpSecure = process.env.SMTP_SECURE === "true";
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const twilioClient = twilio(twilioAccountSid, twilioAuthToken);

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const server = http.createServer(app);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  ensureParentDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function loadRuntimeConfig() {
  const runtime = readJsonFile(runtimePath, null);
  if (!runtime || typeof runtime !== "object") {
    return null;
  }
  return runtime;
}

function loadStateStore() {
  const fallback = { version: 1, updatedAt: null, calls: {} };
  const stored = readJsonFile(statePath, fallback);

  if (!stored || typeof stored !== "object") {
    return fallback;
  }

  if (
    stored.calls &&
    typeof stored.calls === "object" &&
    !Array.isArray(stored.calls)
  ) {
    return {
      version: stored.version || 1,
      updatedAt: stored.updatedAt || null,
      calls: stored.calls,
    };
  }

  if (Array.isArray(stored)) {
    const calls = {};
    for (const entry of stored) {
      if (entry && entry.callSid) {
        calls[entry.callSid] = entry;
      }
    }

    return { version: 1, updatedAt: null, calls };
  }

  return fallback;
}

const stateStore = loadStateStore();
const callState = new Map(Object.entries(stateStore.calls || {}));
const realtimeSessions = new Map();

function persistStateStore() {
  atomicWriteJson(statePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    calls: Object.fromEntries(callState.entries()),
  });
}

function getState(callSid) {
  return callState.get(callSid) || null;
}

function saveState(callSid, updater) {
  const current = getState(callSid) || { callSid };
  const next = updater({ ...current }) || current;
  next.callSid = callSid;
  next.updatedAt = new Date().toISOString();
  if (!next.createdAt) {
    next.createdAt = current.createdAt || next.updatedAt;
  }
  callState.set(callSid, next);
  persistStateStore();
  if (
    current.status !== next.status ||
    current.summary !== next.summary ||
    current.lastError !== next.lastError ||
    current.endReason !== next.endReason ||
    current.completedAt !== next.completedAt ||
    current.lastUserMessage !== next.lastUserMessage ||
    current.lastAgentMessage !== next.lastAgentMessage ||
    current.turn !== next.turn ||
    current.currentGoalKey !== next.currentGoalKey
  ) {
    appendRunEvent(callSid, "state.update", {
      status: next.status || null,
      summary: next.summary || null,
      lastError: next.lastError || null,
      endReason: next.endReason || null,
      completedAt: next.completedAt || null,
      currentGoalKey: next.currentGoalKey || null,
      turn: next.turn || 0,
      lastUserMessage: next.lastUserMessage || null,
      lastAgentMessage: next.lastAgentMessage || null,
    });
  }
  return next;
}

function appendRunEvent(callSid, type, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    callSid: callSid || null,
    type: normalizeText(type) || "event",
    ...details,
  };

  try {
    ensureParentDir(eventLogPath);
    fs.appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error("Failed to append run event:", error);
  }
}

function readRunEvents({ callSid = null, limit = 200 } = {}) {
  try {
    const raw = fs.readFileSync(eventLogPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const parsed = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== "object") {
          continue;
        }
        if (callSid && entry.callSid !== callSid) {
          continue;
        }
        parsed.push(entry);
      } catch {
        continue;
      }
    }

    return parsed.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function getRunDurationMs(state) {
  if (!state?.createdAt) {
    return null;
  }

  const start = Date.parse(state.createdAt);
  const end = Date.parse(state.completedAt || state.updatedAt || new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return Math.max(0, end - start);
}

function formatDuration(ms) {
  if (ms == null) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function summarizeRun(state) {
  if (!state) {
    return null;
  }

  const runDurationMs = getRunDurationMs(state);
  const answers = Array.isArray(state.answers) ? state.answers.length : 0;
  const openGoals = Object.values(state.goals || {}).filter(
    (goal) => goal?.status !== "complete",
  ).length;

  return {
    callSid: state.callSid,
    prospectName: state.prospectName || null,
    propertyName: state.propertyName || null,
    status: state.status || "unknown",
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
    completedAt: state.completedAt || null,
    durationMs: runDurationMs,
    durationLabel: formatDuration(runDurationMs),
    turns: state.turn || 0,
    answers,
    openGoals,
    lastAgentMessage: state.lastAgentMessage || "",
    lastUserMessage: state.lastUserMessage || "",
    lastError: state.lastError || null,
    endReason: state.endReason || null,
    summary: state.summary || "",
    emailStatus: state.emailStatus || null,
  };
}

function listRunSummaries({ limit = 50, status = "" } = {}) {
  const targetStatus = normalizeText(status);
  const runs = Array.from(callState.values())
    .map(summarizeRun)
    .filter(Boolean)
    .filter((run) => (targetStatus ? run.status === targetStatus : true))
    .sort((a, b) => {
      const aTime = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
      const bTime = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
      return bTime - aTime;
    });

  return runs.slice(0, Math.max(1, limit));
}

function requireDashboardAuth(req, res) {
  if (!dashboardUsername || !dashboardPassword) {
    return true;
  }

  const header = normalizeText(req.headers.authorization || "");
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Voice Dashboard"');
    res.status(401).type("text/plain").send("Authentication required");
    return false;
  }

  let credentials = "";
  try {
    credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    credentials = "";
  }

  const separatorIndex = credentials.indexOf(":");
  const username =
    separatorIndex === -1 ? credentials : credentials.slice(0, separatorIndex);
  const password =
    separatorIndex === -1 ? "" : credentials.slice(separatorIndex + 1);

  if (username !== dashboardUsername || password !== dashboardPassword) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Voice Dashboard"');
    res.status(401).type("text/plain").send("Authentication required");
    return false;
  }

  return true;
}

function isTerminalState(state) {
  return (
    state?.status === "completed" ||
    state?.status === "terminated" ||
    state?.status === "failed"
  );
}

function buildGatherTwiML(prompt, nextPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(nextPath)}" method="POST" timeout="${xmlEscape(gatherTimeout)}" speechTimeout="${xmlEscape(gatherSpeechTimeout)}" speechModel="${xmlEscape(gatherSpeechModel)}" actionOnEmptyResult="true">
    <Say voice="${xmlEscape(selectedVoice)}" language="${xmlEscape(selectedLanguage)}">${xmlEscape(prompt)}</Say>
  </Gather>
</Response>`;
}

function buildSayAndHangupTwiML(prompt) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${xmlEscape(selectedVoice)}" language="${xmlEscape(selectedLanguage)}">${xmlEscape(prompt)}</Say>
  <Hangup/>
</Response>`;
}

function buildClosingMessage(state) {
  const name = state?.prospectName || "there";
  if (state?.endReason === "too_many_unclear_responses") {
    return `I'm having trouble hearing you, ${name}. Please call back from a quieter place. Goodbye.`;
  }
  return `Thank you, ${name}. If your application fits, we will be in touch. Goodbye.`;
}

function createMailTransport() {
  if (smtpUrl) {
    return nodemailer.createTransport(smtpUrl);
  }

  if (smtpHost) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort || 587,
      secure: smtpSecure,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    });
  }

  return nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });
}

function getRuntimeBaseUrl() {
  const runtime = loadRuntimeConfig();
  return (
    runtime?.appBaseUrl ||
    runtime?.publicBaseUrl ||
    process.env.VOICE_PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    ""
  );
}

function isLocalhostUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function resolveScreeningUrl(args) {
  const screeningUrl = normalizeText(args.screeningUrl);
  if (screeningUrl) {
    return new URL(screeningUrl);
  }

  const baseUrl = getRuntimeBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Provide screeningUrl or start the launcher first so the live voice URL is available.",
    );
  }

  if (isLocalhostUrl(baseUrl)) {
    throw new Error(
      "APP_BASE_URL is local-only. Twilio needs a public HTTPS URL. Use a tunnel or pass screeningUrl explicitly.",
    );
  }

  return new URL(
    "/voice/start",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
}

function parseBooleanField(value) {
  if (value === true || value === "true" || value === "on" || value === "1") {
    return true;
  }

  if (
    value === false ||
    value === "false" ||
    value === "off" ||
    value === "0" ||
    value === "" ||
    value == null
  ) {
    return false;
  }

  return Boolean(value);
}

function parseIntegerField(value, fieldName, { min, max } = {}) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  if (typeof min === "number" && parsed < min) {
    throw new Error(`${fieldName} must be at least ${min}.`);
  }

  if (typeof max === "number" && parsed > max) {
    throw new Error(`${fieldName} must be at most ${max}.`);
  }

  return parsed;
}

function buildOutboundCallParams(args) {
  const to = normalizeText(args.to);
  const from = normalizeText(args.from) || defaultFromNumber;
  const prospectName = normalizeText(args.prospectName);
  const propertyName = normalizeText(args.propertyName);
  const screeningTwiml = normalizeText(args.screeningTwiml);

  if (!to) {
    throw new Error("Destination phone number is required.");
  }

  if (!from) {
    throw new Error(
      "No caller ID available. Set TWILIO_FROM_NUMBER or pass from explicitly.",
    );
  }

  const params = {
    to,
    from,
    record: parseBooleanField(args.record),
  };

  if (normalizeText(args.screeningUrl) || getRuntimeBaseUrl()) {
    const screeningUrl = resolveScreeningUrl(args);
    if (prospectName) {
      screeningUrl.searchParams.set("prospectName", prospectName);
    }
    if (propertyName) {
      screeningUrl.searchParams.set("propertyName", propertyName);
    }
    params.url = screeningUrl.toString();
  } else if (screeningTwiml) {
    params.twiml = screeningTwiml;
  } else {
    throw new Error("Provide screeningUrl or screeningTwiml.");
  }

  const statusCallback = normalizeText(args.statusCallback);
  if (statusCallback) {
    params.statusCallback = statusCallback;
    params.statusCallbackEvent = [
      "initiated",
      "ringing",
      "answered",
      "completed",
    ];
  }

  const timeout = parseIntegerField(args.timeout, "timeout", {
    min: 5,
    max: 600,
  });
  if (timeout !== null) {
    params.timeout = timeout;
  }

  const machineDetection = normalizeText(args.machineDetection);
  if (machineDetection) {
    params.machineDetection = machineDetection;
  }

  return params;
}

function getVoiceStreamWebSocketUrl() {
  const baseUrl = getRuntimeBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Missing public base URL. Set APP_BASE_URL so Twilio can reach the websocket bridge.",
    );
  }

  const streamUrl = new URL(
    "/voice/stream",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
  return streamUrl.toString();
}

function buildConnectStreamTwiML(callSid, prospectName, propertyName) {
  const streamUrl = getVoiceStreamWebSocketUrl();
  const parameters = [
    ["callSid", callSid],
    ["prospectName", prospectName],
    ["propertyName", propertyName],
  ].filter(([, value]) => normalizeText(value));

  const parameterXml = parameters
    .map(
      ([name, value]) =>
        `      <Parameter name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(streamUrl)}">
${parameterXml ? `${parameterXml}\n` : ""}    </Stream>
  </Connect>
</Response>`;
}

function renderTestingPage() {
  const runtime = loadRuntimeConfig();
  const baseUrl = getRuntimeBaseUrl();
  const publicBaseUrl = baseUrl && !isLocalhostUrl(baseUrl) ? baseUrl : "";
  const defaultScreeningUrl =
    runtime?.voiceStartUrl ||
    (publicBaseUrl ? `${publicBaseUrl}/voice/start` : "");
  const configuredFromNumber = defaultFromNumber || "";
  const context = {
    baseUrl: baseUrl || null,
    publicBaseUrl: publicBaseUrl || null,
    voiceStartUrl: runtime?.voiceStartUrl || null,
    defaultScreeningUrl: defaultScreeningUrl || null,
    defaultFromNumber: configuredFromNumber || null,
    statePath,
  };

  const contextJson = JSON.stringify(context).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice Automation Testing</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090c12;
      --bg-soft: rgba(255, 255, 255, 0.03);
      --panel: rgba(12, 16, 24, 0.92);
      --panel-border: rgba(255, 255, 255, 0.12);
      --text: #f4f7fb;
      --muted: #9ca8b8;
      --accent: #79d7c7;
      --accent-strong: #b6fff1;
      --danger: #ff8c8c;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      --radius: 22px;
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(121, 215, 199, 0.18), transparent 26%),
        radial-gradient(circle at 85% 0%, rgba(176, 122, 255, 0.15), transparent 30%),
        linear-gradient(180deg, #0b1018 0%, #090c12 48%, #06080d 100%);
    }

    .shell {
      min-height: 100vh;
      padding: 28px;
    }

    .frame {
      max-width: 1200px;
      margin: 0 auto;
    }

    .topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 1px solid var(--panel-border);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      text-transform: none;
      letter-spacing: normal;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.05fr) minmax(360px, 0.95fr);
      gap: 24px;
      align-items: start;
    }

    .hero {
      padding: 8px 0 0;
      animation: rise 500ms ease-out both;
    }

    .eyebrow {
      margin: 0 0 14px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      max-width: 11ch;
      font-size: clamp(3rem, 8vw, 5.8rem);
      line-height: 0.94;
      letter-spacing: -0.06em;
    }

    .lede {
      max-width: 56ch;
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.7;
    }

    .notes {
      display: grid;
      gap: 12px;
      margin-top: 28px;
      max-width: 52ch;
    }

    .note {
      padding: 14px 16px;
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.03);
      color: #d7deea;
      line-height: 1.55;
    }

    .panel {
      padding: 22px;
      border: 1px solid var(--panel-border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(16, 21, 31, 0.98), rgba(10, 14, 21, 0.98));
      box-shadow: var(--shadow);
      animation: rise 600ms ease-out 70ms both;
    }

    .panel-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    .panel-title {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: -0.03em;
    }

    .panel-subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
      line-height: 1.55;
    }

    .runtime {
      color: var(--muted);
      font-size: 0.85rem;
      text-align: right;
      line-height: 1.5;
      max-width: 28ch;
    }

    form {
      display: grid;
      gap: 16px;
    }

    .fields {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    label {
      font-size: 0.9rem;
      color: #dbe3ef;
    }

    input, select, textarea {
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.13);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      padding: 13px 14px;
      font: inherit;
      outline: none;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
    }

    textarea {
      min-height: 110px;
      resize: vertical;
    }

    input:focus, select:focus, textarea:focus {
      border-color: rgba(121, 215, 199, 0.85);
      background: rgba(255, 255, 255, 0.06);
    }

    .inline {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 18px;
      align-items: center;
    }

    .check {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: #dbe3ef;
      font-size: 0.95rem;
    }

    .check input {
      width: 18px;
      height: 18px;
      margin: 0;
      accent-color: var(--accent);
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-top: 4px;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 13px 18px;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      color: #041114;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      transition: transform 140ms ease, filter 140ms ease;
    }

    button:hover { transform: translateY(-1px); filter: brightness(1.02); }
    button:disabled { cursor: progress; opacity: 0.75; transform: none; }

    .helper {
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.5;
    }

    .result {
      min-height: 180px;
      margin: 0;
      padding: 16px;
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(0, 0, 0, 0.24);
      overflow: auto;
      color: #dce5f3;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .result[data-state="error"] {
      border-color: rgba(255, 140, 140, 0.35);
      color: #ffd0d0;
    }

    .statusline {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
      color: var(--muted);
      font-size: 0.88rem;
    }

    .pill {
      padding: 7px 10px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.03);
    }

    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(18px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (max-width: 940px) {
      .shell { padding: 18px; }
      .grid { grid-template-columns: 1fr; }
      .panel { padding: 18px; }
      h1 { max-width: 12ch; }
    }

    @media (max-width: 640px) {
      .topline { flex-direction: column; align-items: start; }
      .fields { grid-template-columns: 1fr; }
      .actions { flex-direction: column; align-items: stretch; }
      button { width: 100%; }
      h1 { font-size: clamp(2.6rem, 15vw, 4rem); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="frame">
      <div class="topline">
        <div class="badge">/testing</div>
        <div class="badge">Voice agent trigger surface</div>
      </div>

      <div class="grid">
        <section class="hero">
          <p class="eyebrow">Operator console</p>
          <h1>Trigger the voice automation agent.</h1>
          <p class="lede">
            Use this page to launch an outbound screening call from the browser.
            The form sends the request to the voice bridge, which hands the call to the agent when Twilio connects.
          </p>

          <div class="notes">
            <div class="note">Leave <strong>Screening URL</strong> blank to use the runtime default when it is available.</div>
            <div class="note">The call request uses your configured Twilio caller ID unless you override the <strong>From</strong> field.</div>
            <div class="note">You can keep this page open while the call runs and check the returned <strong>Call SID</strong> for follow-up.</div>
          </div>

          <div class="statusline" id="runtime-status"></div>
        </section>

        <section class="panel runs-panel">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">Start a call</h2>
              <p class="panel-subtitle">Provide the destination number and any context you want passed into the screening flow.</p>
            </div>
            <div class="runtime" id="runtime-summary"></div>
          </div>

          <form id="testing-form" action="/testing/start" method="post">
            <div class="fields">
              <div class="field">
                <label for="to">To phone number</label>
                <input id="to" name="to" type="tel" autocomplete="tel" placeholder="+15551234567" required />
              </div>
              <div class="field">
                <label for="from">From phone number</label>
                <input id="from" name="from" type="tel" autocomplete="tel" placeholder="+15557654321" />
              </div>
              <div class="field">
                <label for="prospectName">Prospect name</label>
                <input id="prospectName" name="prospectName" type="text" autocomplete="off" placeholder="Jordan Lee" />
              </div>
              <div class="field">
                <label for="propertyName">Property name</label>
                <input id="propertyName" name="propertyName" type="text" autocomplete="off" placeholder="North Ridge Apartments" />
              </div>
              <div class="field full">
                <label for="screeningUrl">Screening URL</label>
                <input id="screeningUrl" name="screeningUrl" type="url" autocomplete="off" placeholder="Auto-resolved from runtime if left blank" />
              </div>
              <div class="field full">
                <label for="statusCallback">Status callback URL</label>
                <input id="statusCallback" name="statusCallback" type="url" autocomplete="off" placeholder="https://example.com/twilio-status" />
              </div>
              <div class="field">
                <label for="timeout">Ring timeout seconds</label>
                <input id="timeout" name="timeout" type="number" min="5" max="600" step="1" placeholder="30" />
              </div>
              <div class="field">
                <label for="machineDetection">Machine detection</label>
                <select id="machineDetection" name="machineDetection">
                  <option value="">Off</option>
                  <option value="Enable">Enable</option>
                  <option value="DetectMessageEnd">DetectMessageEnd</option>
                </select>
              </div>
              <div class="field full">
                <div class="inline">
                  <label class="check">
                    <input id="record" name="record" type="checkbox" value="true" />
                    Record this call
                  </label>
                </div>
              </div>
            </div>

            <div class="actions">
              <div class="helper">Submitting starts the outbound call immediately and returns the Twilio response.</div>
              <button type="submit" id="submit-button">Start voice agent</button>
            </div>
          </form>

          <div class="statusline">
            <span class="pill">Runtime default is injected server-side when available</span>
            <span class="pill">Response appears below</span>
          </div>

          <pre class="result" id="result" aria-live="polite">No call has been started yet.</pre>
        </section>
      </div>
    </div>
  </div>

  <script>
    window.__VOICE_TESTING_CONTEXT__ = ${contextJson};
    const context = window.__VOICE_TESTING_CONTEXT__ || {};
    const runtimeStatus = document.getElementById('runtime-status');
    const runtimeSummary = document.getElementById('runtime-summary');
    const form = document.getElementById('testing-form');
    const result = document.getElementById('result');
    const submitButton = document.getElementById('submit-button');

    function setTextContent(node, values) {
      node.textContent = '';
      values.forEach((value) => {
        const span = document.createElement('span');
        span.className = 'pill';
        span.textContent = value;
        node.appendChild(span);
      });
    }

    setTextContent(runtimeStatus, [
      context.baseUrl ? \`Base URL: \${context.baseUrl}\` : 'Base URL: not loaded',
      context.voiceStartUrl ? \`Voice start: \${context.voiceStartUrl}\` : 'Voice start: resolved server-side',
    ]);

    runtimeSummary.textContent = context.defaultFromNumber
      ? \`Default caller ID: \${context.defaultFromNumber}\`
      : 'Default caller ID: not set';

    if (context.defaultScreeningUrl) {
      document.getElementById('screeningUrl').value = context.defaultScreeningUrl;
    }

    if (context.defaultFromNumber) {
      document.getElementById('from').value = context.defaultFromNumber;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      submitButton.disabled = true;
      submitButton.textContent = 'Starting...';
      result.dataset.state = '';
      result.textContent = 'Sending request to the voice bridge...';

      try {
        const formData = new FormData(form);
        const payload = {};

        for (const [key, value] of formData.entries()) {
          if (value === '') {
            continue;
          }
          payload[key] = value;
        }

        payload.record = form.record.checked;

        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || body.message || 'Failed to start the call.');
        }

        result.dataset.state = 'ok';
        result.textContent = JSON.stringify(body, null, 2);
      } catch (error) {
        result.dataset.state = 'error';
        result.textContent = error.message || String(error);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Start voice agent';
      }
    });
  </script>
</body>
</html>`;
}

function parseLimitParam(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function renderDashboardPage() {
  const context = {
    dashboardEnabled: true,
    authEnabled: Boolean(dashboardUsername && dashboardPassword),
    generatedAt: new Date().toISOString(),
  };

  const contextJson = JSON.stringify(context).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SOPM Voice Dashboard</title>
  <script>
    (function () {
      try {
        const key = 'voice-dashboard-theme';
        const stored = localStorage.getItem(key);
        const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        const theme = stored === 'dark' || stored === 'light' ? stored : preferred;
        document.documentElement.dataset.theme = theme;
      } catch {
        document.documentElement.dataset.theme = 'light';
      }
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe7;
      --panel: rgba(255, 255, 255, 0.74);
      --panel-soft: rgba(47, 111, 95, 0.06);
      --border: rgba(41, 54, 68, 0.12);
      --border-strong: rgba(41, 54, 68, 0.18);
      --text: #1f2a33;
      --muted: #66707b;
      --accent: #2f6f5f;
      --accent-strong: #1f4f43;
      --accent-soft: #e4efe9;
      --danger: #9b4848;
      --warn: #9b7843;
      --shadow: 0 18px 40px rgba(31, 42, 51, 0.06);
      --radius: 18px;
    }

    :root[data-theme='dark'] {
      color-scheme: dark;
      --bg: #0d1413;
      --panel: rgba(15, 21, 20, 0.82);
      --panel-soft: rgba(111, 179, 157, 0.08);
      --border: rgba(213, 236, 230, 0.14);
      --border-strong: rgba(213, 236, 230, 0.24);
      --text: #e8f0eb;
      --muted: #97a7a0;
      --accent: #74bda8;
      --accent-strong: #dbf1e8;
      --accent-soft: rgba(111, 179, 157, 0.12);
      --danger: #ef9191;
      --warn: #e0b56e;
      --shadow: 0 22px 46px rgba(0, 0, 0, 0.26);
    }

    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(47, 111, 95, 0.10), transparent 28%),
        radial-gradient(circle at 92% 2%, rgba(182, 158, 117, 0.12), transparent 24%),
        linear-gradient(180deg, #f7f3ed 0%, #f1ebe2 100%);
    }

    :root[data-theme='dark'] body {
      background:
        radial-gradient(circle at top left, rgba(116, 189, 168, 0.16), transparent 28%),
        radial-gradient(circle at 92% 2%, rgba(177, 148, 107, 0.10), transparent 24%),
        linear-gradient(180deg, #0f1715 0%, #0a1110 100%);
    }

    .shell {
      min-height: 100vh;
      padding: 24px 22px 40px;
    }

    .frame {
      max-width: 1280px;
      margin: 0 auto;
    }

    .topbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
    }

    .topbar-main {
      display: grid;
      gap: 10px;
      min-width: min(100%, 520px);
    }

    .topbar-actions {
      display: grid;
      gap: 10px;
      justify-items: end;
      flex: 1 1 420px;
    }

    .stats {
      justify-content: flex-end;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
    }

    .theme-toggle {
      width: 44px;
      height: 44px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--border);
      color: var(--accent-strong);
    }

    .theme-toggle svg {
      width: 18px;
      height: 18px;
      display: block;
    }

    .theme-toggle:hover {
      box-shadow: none;
      background: rgba(255, 255, 255, 0.88);
    }

    :root[data-theme='dark'] .theme-toggle {
      background: rgba(18, 25, 23, 0.86);
      color: var(--accent-strong);
    }

    :root[data-theme='dark'] .theme-toggle:hover {
      background: rgba(23, 31, 29, 0.98);
    }

    .test-inline {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
    }

    .test-inline-field {
      display: grid;
      gap: 6px;
      min-width: 150px;
    }

    .test-inline-field label,
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .test-inline-field input {
      width: 100%;
      min-width: 170px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.78);
      color: var(--text);
      padding: 10px 14px;
      font: inherit;
      outline: none;
    }

    .test-inline-field input:focus {
      border-color: rgba(47, 111, 95, 0.38);
      background: rgba(255, 255, 255, 0.95);
    }

    .test-inline-result {
      margin: 0;
      color: var(--muted);
      font-size: 0.84rem;
      line-height: 1.5;
      text-align: right;
      max-width: 46ch;
    }

    .eyebrow {
      color: var(--accent);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      margin: 0 0 8px;
    }

    h1 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(2.1rem, 4.2vw, 3.3rem);
      line-height: 1;
      letter-spacing: -0.045em;
      font-weight: 600;
      color: var(--accent-strong);
    }

    .lede {
      max-width: 60ch;
      margin: 12px 0 0;
      color: var(--muted);
      line-height: 1.65;
      font-size: 0.98rem;
    }

    button, select {
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.72);
      color: var(--text);
      font: inherit;
      padding: 10px 14px;
      box-shadow: none;
    }

    button {
      cursor: pointer;
      background: var(--accent);
      color: #ffffff;
      font-weight: 700;
      border-color: transparent;
      transition: transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }

    button:hover {
      transform: translateY(-1px);
      background: var(--accent-strong);
      box-shadow: 0 8px 16px rgba(31, 79, 67, 0.16);
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.68);
      color: var(--muted);
      font-size: 0.9rem;
    }

    button.pill {
      cursor: pointer;
      color: var(--accent-strong);
      background: rgba(47, 111, 95, 0.06);
      transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
    }

    button.pill:hover {
      transform: translateY(-1px);
      background: rgba(47, 111, 95, 0.1);
      border-color: rgba(47, 111, 95, 0.22);
      box-shadow: none;
    }

    button.pill.is-active-filter {
      background: rgba(47, 111, 95, 0.16);
      border-color: rgba(47, 111, 95, 0.3);
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.22fr);
      gap: 20px;
      align-items: start;
    }

    .panel {
      border-top: 1px solid var(--border);
      border-radius: var(--radius);
      background: transparent;
      box-shadow: none;
      overflow: hidden;
    }

    .runs-panel {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      align-self: stretch;
      min-height: 0;
    }

    .panel-header {
      padding: 16px 18px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
    }

    .panel-title {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 1.05rem;
      letter-spacing: -0.03em;
      color: var(--accent-strong);
    }

    .panel-subtitle {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 0.88rem;
      line-height: 1.5;
    }

    .list {
      display: grid;
      margin: 14px 18px 0;
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.55);
    }

    .runs-panel .list {
      margin-top: 14px;
      min-height: 0;
      max-height: calc(100vh - 280px);
      overflow-y: auto;
      overflow-x: hidden;
      align-content: start;
    }

    .day-group {
      display: grid;
      gap: 0;
      border-bottom: 1px solid var(--border);
    }

    .day-group:last-child {
      border-bottom: 0;
    }

    .day-label {
      padding: 12px 16px 10px;
      background: rgba(47, 111, 95, 0.04);
      color: var(--accent-strong);
      font-size: 0.74rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(41, 54, 68, 0.08);
    }

    .run {
      display: grid;
      gap: 8px;
      padding: 14px 16px;
      border: 0;
      border-bottom: 1px solid rgba(41, 54, 68, 0.08);
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      border-radius: 0;
      transition: background 140ms ease, transform 140ms ease;
    }

    .run:hover,
    .run[data-selected="true"] {
      background: var(--accent-soft);
    }

    .run-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
      font-size: 0.97rem;
      font-weight: 600;
    }

    .run-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .status {
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(47, 111, 95, 0.08);
      color: var(--accent-strong);
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border: 1px solid rgba(47, 111, 95, 0.14);
    }

    .status.failed, .status.terminated {
      color: var(--danger);
      background: rgba(155, 72, 72, 0.08);
      border-color: rgba(155, 72, 72, 0.16);
    }
    .status.pending, .status.partial {
      color: var(--warn);
      background: rgba(155, 120, 67, 0.08);
      border-color: rgba(155, 120, 67, 0.16);
    }

    .detail {
      padding: 16px 18px 18px;
      display: grid;
      gap: 14px;
    }

    .summary-card {
      padding: 16px 0 18px;
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 10px;
    }

    .summary-card-header,
    .transcript-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .summary-card .value {
      font-size: 1rem;
      line-height: 1.65;
    }

    .detail-stack {
      display: grid;
      gap: 12px;
    }

    .detail-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .card {
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      background: transparent;
      border-radius: 0;
    }

    .label {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      margin-bottom: 7px;
    }

    .value {
      color: var(--text);
      font-size: 0.95rem;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }

    pre {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.70);
      color: #25313a;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      overflow: auto;
      min-height: 150px;
    }

    .section {
      display: grid;
      gap: 10px;
    }

    .transcript-details {
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.48);
    }

    .transcript-details > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--accent-strong);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 0.98rem;
      letter-spacing: -0.02em;
      user-select: none;
    }

    .transcript-details > summary::-webkit-details-marker {
      display: none;
    }

    .transcript-details > summary::after {
      content: "Open";
      font-family: inherit;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
    }

    .transcript-details[open] > summary::after {
      content: "Close";
    }

    .transcript-details[open] .transcript-list {
      margin-top: 12px;
      max-height: 420px;
      overflow: auto;
      padding-right: 6px;
    }

    .copy-button {
      padding: 8px 12px;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .section h3 {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 0.96rem;
      letter-spacing: -0.02em;
      color: var(--accent-strong);
    }

    .transcript-list {
      display: grid;
      gap: 10px;
    }

    .transcript-item {
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.68);
      display: grid;
      gap: 6px;
    }

    .transcript-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .transcript-role {
      font-weight: 700;
      color: var(--accent-strong);
    }

    .transcript-goal {
      margin-left: auto;
      text-align: right;
    }

    .runs-panel-header {
      align-items: flex-start;
    }

    .runs-panel-copy {
      display: grid;
      gap: 10px;
      width: 100%;
    }

    .runs-panel-copy .stats {
      margin-top: 0;
      justify-content: flex-start;
    }

    .transcript-text {
      color: var(--text);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      padding: 18px 16px;
      color: var(--muted);
      line-height: 1.6;
    }

    :root[data-theme='dark'] .pill,
    :root[data-theme='dark'] .test-inline-field input,
    :root[data-theme='dark'] select,
    :root[data-theme='dark'] .list,
    :root[data-theme='dark'] .transcript-details,
    :root[data-theme='dark'] .transcript-item,
    :root[data-theme='dark'] pre {
      background: rgba(16, 23, 21, 0.78);
      border-color: var(--border);
      color: var(--text);
    }

    :root[data-theme='dark'] .test-inline-field input:focus {
      background: rgba(19, 28, 26, 0.96);
      border-color: rgba(116, 189, 168, 0.42);
    }

    :root[data-theme='dark'] .day-label {
      background: rgba(111, 179, 157, 0.10);
      border-bottom-color: rgba(213, 236, 230, 0.08);
    }

    :root[data-theme='dark'] .run:hover,
    :root[data-theme='dark'] .run[data-selected="true"] {
      background: rgba(111, 179, 157, 0.12);
    }

    :root[data-theme='dark'] .status {
      background: rgba(111, 179, 157, 0.12);
      border-color: rgba(111, 179, 157, 0.22);
    }

    :root[data-theme='dark'] .status.failed,
    :root[data-theme='dark'] .status.terminated {
      background: rgba(240, 141, 141, 0.10);
      border-color: rgba(240, 141, 141, 0.18);
    }

    :root[data-theme='dark'] .status.pending,
    :root[data-theme='dark'] .status.partial {
      background: rgba(224, 181, 110, 0.10);
      border-color: rgba(224, 181, 110, 0.18);
    }

    @media (max-width: 1080px) {
      .grid { grid-template-columns: 1fr; }
      .runs-panel .list {
        max-height: none;
      }
    }

    @media (max-width: 720px) {
      .shell { padding: 16px 14px 32px; }
      .detail-grid { grid-template-columns: 1fr; }
      .toolbar { width: 100%; }
      .topbar-actions { width: 100%; justify-items: stretch; }
      .stats { justify-content: flex-start; }
      .test-inline { width: 100%; }
      .test-inline-field { flex: 1 1 0; }
      .test-inline-field input { min-width: 0; width: 100%; }
      .test-inline-result { text-align: left; }
      button, select { width: 100%; }
      .theme-toggle { width: 44px; }
      .topbar { align-items: stretch; }
      .panel-header { flex-direction: column; align-items: start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="frame">
      <div class="topbar">
        <div class="topbar-main">
          <p class="eyebrow">SOPM Operations</p>
          <h1>Voice Agent Dashboard</h1>
          <p class="lede">Simple view of active runs, stored state, and recent events. Built to stay calm, legible, and quick to scan.</p>
        </div>
        <div class="topbar-actions">
          <div class="toolbar">
            <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode" aria-pressed="false" title="Toggle dark mode">
              <span class="sr-only">Toggle dark mode</span>
            </button>
            <form class="test-inline" id="dashboard-test-form" action="/testing/start" method="post">
              <div class="test-inline-field">
                <label for="dashboardTo">Phone number</label>
                <input id="dashboardTo" name="to" type="tel" autocomplete="tel" placeholder="+15551234567" required />
              </div>
              <div class="test-inline-field">
                <label for="dashboardProspectName">Name</label>
                <input id="dashboardProspectName" name="prospectName" type="text" autocomplete="off" placeholder="Jordan Lee" required />
              </div>
              <button type="submit" id="dashboard-test-button">Start test</button>
            </form>
          </div>
          <div class="test-inline-result" id="dashboard-test-result" aria-live="polite">No test call has been started yet.</div>
        </div>
      </div>

      <div class="grid">
        <section class="panel">
          <div class="panel-header runs-panel-header">
            <div class="runs-panel-copy">
              <div>
              <h2 class="panel-title">Runs</h2>
              <p class="panel-subtitle">Latest calls and their status.</p>
              </div>
              <div class="meta stats" id="stats"></div>
            </div>
          </div>
          <div id="runs" class="list"></div>
        </section>

        <section class="panel">
          <div class="panel-header">
          <div>
              <h2 class="panel-title">Selected run</h2>
              <p class="panel-subtitle">Summary and transcript.</p>
            </div>
            <div class="pill" id="selected-id">No run selected</div>
          </div>
          <div class="detail" id="detail">
            <div class="empty">Select a run on the left to inspect its state and logs.</div>
          </div>
        </section>
      </div>
    </div>
  </div>

  <script>
    window.__VOICE_DASHBOARD_CONTEXT__ = ${contextJson};
    const state = {
      runs: [],
      selected: null,
      detail: null,
      logs: [],
      activeStatusFilter: '',
    };

    const runsEl = document.getElementById('runs');
    const detailEl = document.getElementById('detail');
    const selectedIdEl = document.getElementById('selected-id');
    const statsEl = document.getElementById('stats');
    const themeToggleButton = document.getElementById('theme-toggle');
    const dashboardTestForm = document.getElementById('dashboard-test-form');
    const dashboardTestButton = document.getElementById('dashboard-test-button');
    const dashboardTestResult = document.getElementById('dashboard-test-result');
    const THEME_STORAGE_KEY = 'voice-dashboard-theme';
    const themeIcons = {
      light:
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4.75" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M4.5 4.5l1.6 1.6M17.9 17.9l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.5 19.5l1.6-1.6M17.9 6.1l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
      dark:
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.2 14.8A6.9 6.9 0 1 1 9.2 5.8a7.6 7.6 0 1 0 9 9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    };

    function getTheme() {
      return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    function syncThemeToggle(theme) {
      if (!themeToggleButton) {
        return;
      }

      themeToggleButton.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      themeToggleButton.setAttribute(
        'aria-label',
        theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      );
      themeToggleButton.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      themeToggleButton.innerHTML = theme === 'dark' ? themeIcons.light : themeIcons.dark;
    }

    function setTheme(theme) {
      const next = theme === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore storage errors in private mode or restricted browsers.
      }
      syncThemeToggle(next);
    }

    syncThemeToggle(getTheme());

    if (themeToggleButton) {
      themeToggleButton.addEventListener('click', () => {
        setTheme(getTheme() === 'dark' ? 'light' : 'dark');
      });
    }

    function pill(text) {
      const span = document.createElement('span');
      span.className = 'pill';
      span.textContent = text;
      return span;
    }

    function formatTime(value) {
      if (!value) return 'n/a';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    }

    function getRunTimestamp(run) {
      const value = run.updatedAt || run.createdAt || 0;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function getDayKey(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return 'unknown';
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ].join('-');
    }

    function formatDayLabel(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return 'Unknown day';
      const today = new Date();
      const isSameDay =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();
      if (isSameDay) return 'Today';

      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      const isYesterday =
        date.getFullYear() === yesterday.getFullYear() &&
        date.getMonth() === yesterday.getMonth() &&
        date.getDate() === yesterday.getDate();
      if (isYesterday) return 'Yesterday';

      return date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }

    function normalizeTranscriptText(value) {
      return String(value || '').trim();
    }

    function getRunPhoneNumber(logs) {
      if (!Array.isArray(logs)) {
        return '';
      }

      for (const event of logs) {
        if (!event || typeof event !== 'object') {
          continue;
        }

        if (event.type === 'testing.call.created' && event.to) {
          return String(event.to).trim();
        }

        if ((event.type === 'testing.call.created' || event.type === 'voice.start') && event.from) {
          return String(event.from).trim();
        }
      }

      return '';
    }

    function getSelectedRunLabel(run, logs) {
      if (!run) {
        return 'No run selected';
      }

      const name = String(run.prospectName || '').trim();
      const phone = getRunPhoneNumber(logs);

      if (name && phone) {
        return name + ' · ' + phone;
      }
      if (name) {
        return name;
      }
      if (phone) {
        return phone;
      }
      return 'Run selected';
    }

    function buildTranscriptCopyText(entries) {
      if (!Array.isArray(entries) || !entries.length) {
        return 'No transcript captured yet.';
      }

      return entries
        .map((item) => {
          const parts = [
            item.role || 'Speaker',
            formatTime(item.ts),
          ];
          if (item.goal) {
            parts.push(item.goal.replace(/_/g, ' '));
          }
          return parts.join(' | ') + '\\n' + item.text;
        })
        .join('\\n\\n');
    }

    async function copyToClipboard(text) {
      const value = String(text || '');
      if (!value.trim()) {
        return false;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }

      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    }

    function buildTranscriptEntries(detail, logs) {
      const entries = [];
      const events = Array.isArray(logs) ? logs.slice().reverse() : [];
      const rawEntries = [];
      let sawRawTranscriptEvents = false;

      for (const event of events) {
        if (!event) {
          continue;
        }

        if (event.type === 'transcript.user' || event.type === 'transcript.agent') {
          sawRawTranscriptEvents = true;
          const text = normalizeTranscriptText(event.text);
          if (!text) {
            continue;
          }
          rawEntries.push({
            role: event.type === 'transcript.user' ? 'Caller' : 'Agent',
            text,
            ts: event.ts || '',
            goal: event.currentGoalKey || '',
          });
        }
      }

      if (sawRawTranscriptEvents && rawEntries.length) {
        return rawEntries;
      }

      let lastUser = '';
      let lastAgent = '';

      for (const event of events) {
        if (!event || event.type !== 'state.update') {
          continue;
        }

        const ts = event.ts || '';
        const goal = event.currentGoalKey || '';
        const userText = normalizeTranscriptText(event.lastUserMessage);
        const agentText = normalizeTranscriptText(event.lastAgentMessage);

        if (userText && userText !== lastUser) {
          entries.push({
            role: 'Caller',
            text: userText,
            ts,
            goal,
          });
          lastUser = userText;
        }

        if (agentText && agentText !== lastAgent) {
          entries.push({
            role: 'Agent',
            text: agentText,
            ts,
            goal,
          });
          lastAgent = agentText;
        }
      }

      if (!entries.length && detail?.state) {
        const state = detail.state;
        const lastUserMessage = normalizeTranscriptText(state.lastUserMessage);
        const lastAgentMessage = normalizeTranscriptText(state.lastAgentMessage);

        if (lastUserMessage) {
          entries.push({
            role: 'Caller',
            text: lastUserMessage,
            ts: state.updatedAt || state.completedAt || state.createdAt || '',
            goal: state.currentGoalKey || '',
          });
        }

        if (lastAgentMessage) {
          entries.push({
            role: 'Agent',
            text: lastAgentMessage,
            ts: state.updatedAt || state.completedAt || state.createdAt || '',
            goal: state.currentGoalKey || '',
          });
        }
      }

      return entries;
    }

    function renderStats(summary) {
      statsEl.replaceChildren();
      const items = [
        { label: 'Total', value: summary.totalRuns, status: '' },
        { label: 'Active', value: summary.activeRuns, status: 'active' },
        { label: 'Completed', value: summary.completedRuns, status: 'completed' },
        { label: 'Failed', value: summary.failedRuns, status: 'failed' },
      ];

      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pill';
        button.textContent = item.label + ': ' + item.value;
        button.addEventListener('click', async () => {
          const current = item.status;
          state.activeStatusFilter = current;
          await loadRuns().catch(showError);
        });
        if ((state.activeStatusFilter || '') === item.status) {
          button.classList.add('is-active-filter');
        }
        statsEl.appendChild(button);
      }
    }

    function renderRuns() {
      runsEl.replaceChildren();

      if (!state.runs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No runs yet. Start a call and it will appear here.';
        runsEl.appendChild(empty);
        return;
      }

      const sortedRuns = state.runs.slice().sort((a, b) => getRunTimestamp(b) - getRunTimestamp(a));
      const groups = [];

      for (const run of sortedRuns) {
        const timestamp = getRunTimestamp(run);
        const dayKey = getDayKey(timestamp);
        let group = groups[groups.length - 1];

        if (!group || group.key !== dayKey) {
          group = {
            key: dayKey,
            label: formatDayLabel(timestamp),
            runs: [],
          };
          groups.push(group);
        }

        group.runs.push(run);
      }

      for (const group of groups) {
        const groupEl = document.createElement('section');
        groupEl.className = 'day-group';

        const label = document.createElement('div');
        label.className = 'day-label';
        label.textContent = group.label;
        groupEl.appendChild(label);

        for (const run of group.runs) {
          const button = document.createElement('button');
          button.className = 'run';
          button.type = 'button';
          button.dataset.selected = String(run.callSid === state.selected);

          const title = document.createElement('div');
          title.className = 'run-title';
          const name = document.createElement('span');
          name.textContent = run.prospectName || run.callSid;
          const status = document.createElement('span');
          status.className = 'status ' + (run.status || 'unknown');
          status.textContent = run.status || 'unknown';
          title.append(name, status);

          const meta = document.createElement('div');
          meta.className = 'run-meta';
          meta.textContent = [
            run.propertyName || 'No property',
            run.durationLabel ? 'Duration ' + run.durationLabel : 'Duration n/a',
            'Updated ' + formatTime(run.updatedAt),
          ].join(' · ');

          button.append(title, meta);
          button.addEventListener('click', () => selectRun(run.callSid));
          groupEl.appendChild(button);
        }

        runsEl.appendChild(groupEl);
      }
    }

    function renderDetail() {
      detailEl.replaceChildren();

      if (!state.detail) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Select a run on the left to inspect its state and logs.';
        detailEl.appendChild(empty);
        selectedIdEl.textContent = 'No run selected';
        return;
      }

      const run = state.detail.run;
      selectedIdEl.textContent = getSelectedRunLabel(run, state.logs);

      const summaryCard = document.createElement('div');
      summaryCard.className = 'summary-card';
      const summaryHeader = document.createElement('div');
      summaryHeader.className = 'summary-card-header';
      const summaryLabel = document.createElement('div');
      summaryLabel.className = 'label';
      summaryLabel.textContent = 'Summary';
      const summaryCopyButton = document.createElement('button');
      summaryCopyButton.type = 'button';
      summaryCopyButton.className = 'pill copy-button';
      summaryCopyButton.textContent = 'Copy summary';
      summaryCopyButton.addEventListener('click', async () => {
        const copied = await copyToClipboard(run.summary || '');
        summaryCopyButton.textContent = copied ? 'Copied' : 'Copy summary';
        if (copied) {
          setTimeout(() => {
            summaryCopyButton.textContent = 'Copy summary';
          }, 1200);
        }
      });
      summaryHeader.append(summaryLabel, summaryCopyButton);
      const summaryValue = document.createElement('div');
      summaryValue.className = 'value';
      summaryValue.textContent = run.summary || 'No summary stored yet.';
      summaryCard.append(summaryHeader, summaryValue);

      const transcriptCard = document.createElement('details');
      transcriptCard.className = 'transcript-details section';
      transcriptCard.open = true;
      const transcriptHeading = document.createElement('summary');
      transcriptHeading.textContent = 'Transcript';
      const transcriptList = document.createElement('div');
      transcriptList.className = 'transcript-list';
      const transcriptActions = document.createElement('div');
      transcriptActions.className = 'summary-card-header';
      transcriptActions.style.paddingTop = '10px';
      transcriptActions.style.paddingBottom = '2px';
      const transcriptHint = document.createElement('div');
      transcriptHint.className = 'label';
      transcriptHint.textContent = 'Copy the full turn-by-turn transcript';
      const transcriptCopyButton = document.createElement('button');
      transcriptCopyButton.type = 'button';
      transcriptCopyButton.className = 'pill copy-button';
      transcriptCopyButton.textContent = 'Copy transcript';
      transcriptCopyButton.addEventListener('click', async () => {
        const copied = await copyToClipboard(buildTranscriptCopyText(transcriptEntries));
        transcriptCopyButton.textContent = copied ? 'Copied' : 'Copy transcript';
        if (copied) {
          setTimeout(() => {
            transcriptCopyButton.textContent = 'Copy transcript';
          }, 1200);
        }
      });
      transcriptActions.append(transcriptHint, transcriptCopyButton);

      const transcriptEntries = buildTranscriptEntries(state.detail, state.logs);

      if (transcriptEntries.length) {
        for (const item of transcriptEntries) {
          const row = document.createElement('div');
          row.className = 'transcript-item';
          const meta = document.createElement('div');
          meta.className = 'transcript-meta';
          const role = document.createElement('span');
          role.className = 'transcript-role';
          role.textContent = item.role;
          const time = document.createElement('span');
          time.textContent = formatTime(item.ts);
          meta.append(role, time);
          if (item.goal) {
            const goal = document.createElement('span');
            goal.className = 'transcript-goal';
            goal.textContent = item.goal.replace(/_/g, ' ');
            meta.append(goal);
          }
          const text = document.createElement('div');
          text.className = 'transcript-text';
          text.textContent = item.text;
          row.append(meta, text);
          transcriptList.appendChild(row);
        }
      } else {
        const emptyTranscript = document.createElement('div');
        emptyTranscript.className = 'empty';
        emptyTranscript.textContent = 'No transcript captured yet.';
        transcriptList.appendChild(emptyTranscript);
      }

      transcriptCard.append(transcriptHeading, transcriptActions, transcriptList);

      const grid = document.createElement('div');
      grid.className = 'detail-grid';

      const cards = [
        ['Status', run.status || 'unknown'],
        ['Prospect', run.prospectName || 'n/a'],
        ['Property', run.propertyName || 'n/a'],
        ['Duration', run.durationLabel || 'n/a'],
        ['Turns', String(run.turns || 0)],
        ['Answers', String(run.answers || 0)],
        ['Open goals', String(run.openGoals || 0)],
      ];

      for (const [label, value] of cards) {
        const card = document.createElement('div');
        card.className = 'card';
        const labelEl = document.createElement('div');
        labelEl.className = 'label';
        labelEl.textContent = label;
        const valueEl = document.createElement('div');
        valueEl.className = 'value';
        valueEl.textContent = value;
        card.append(labelEl, valueEl);
        grid.appendChild(card);
      }

      detailEl.append(summaryCard, transcriptCard, grid);
    }

    async function fetchJson(url) {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || body.message || 'Request failed: ' + response.status);
      }
      return body;
    }

    async function selectRun(callSid) {
      state.selected = callSid;
      renderRuns();

      try {
        const [detail, logs] = await Promise.all([
          fetchJson('/dashboard/api/runs/' + encodeURIComponent(callSid)),
          fetchJson('/dashboard/api/runs/' + encodeURIComponent(callSid) + '/logs?limit=500'),
        ]);
        state.detail = detail;
        state.logs = logs.events || [];
        renderRuns();
        renderDetail();
      } catch (error) {
        state.detail = null;
        state.logs = [];
        detailEl.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = error.message || String(error);
        detailEl.appendChild(empty);
      }
    }

    async function loadRuns() {
      const status = state.activeStatusFilter || '';
      const runs = await fetchJson('/dashboard/api/runs?limit=100&status=' + encodeURIComponent(status));
      state.runs = runs.runs || [];
      renderStats(runs.stats || {});
      renderRuns();
      if (!state.selected && state.runs.length) {
        await selectRun(state.runs[0].callSid);
      } else if (state.selected && !state.runs.some((run) => run.callSid === state.selected)) {
        state.selected = null;
        state.detail = null;
        state.logs = [];
        renderDetail();
      }
    }

    function showError(error) {
      detailEl.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = error.message || String(error);
      detailEl.appendChild(empty);
    }

    dashboardTestForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      dashboardTestButton.disabled = true;
      dashboardTestButton.textContent = 'Starting...';
      dashboardTestResult.dataset.state = '';
      dashboardTestResult.textContent = 'Sending test call...';

      try {
        const formData = new FormData(dashboardTestForm);
        const payload = {};

        for (const [key, value] of formData.entries()) {
          if (value === '') {
            continue;
          }
          payload[key] = value;
        }

        const response = await fetch(dashboardTestForm.action, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || body.message || 'Failed to start the test call.');
        }

        dashboardTestResult.dataset.state = 'ok';
        dashboardTestResult.textContent = 'Test call started for ' + (body.prospectName || 'the selected name') + '.';
        await loadRuns().catch(() => {});
      } catch (error) {
        dashboardTestResult.dataset.state = 'error';
        dashboardTestResult.textContent = error.message || 'Failed to start test call.';
      } finally {
        dashboardTestButton.disabled = false;
        dashboardTestButton.textContent = 'Start test';
      }
    });

    loadRuns().catch(showError);
    setInterval(() => loadRuns().catch(() => {}), 10000);
  </script>
</body>
</html>`;
}

function buildEmailText(state) {
  const answers = Array.isArray(state.answers) ? state.answers : [];
  const lines = [];
  lines.push(
    `Tenant screening summary for ${state.prospectName || "unknown prospect"}`,
  );
  lines.push(`Property: ${state.propertyName || "unknown property"}`);
  lines.push(`Call SID: ${state.callSid}`);
  lines.push("");
  lines.push(
    state.summary || state.lastAgentMessage || "No summary available.",
  );
  lines.push("");
  lines.push("Answers:");
  for (const answer of answers) {
    const label =
      answer.goalLabel || answer.goalKey || `Question ${answer.questionNumber}`;
    lines.push(`${label}: ${answer.answer}`);
  }
  return lines.join("\n");
}

async function sendSummaryEmail(callSid) {
  const state = getState(callSid);
  if (!state || state.status !== "completed") {
    return;
  }

  const transport = createMailTransport();
  if (!transport) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: "skipped_no_transport",
      emailTo: summaryEmailTo,
      emailError: null,
    }));
    return;
  }

  if (!summaryEmailFrom) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: "failed",
      emailTo: summaryEmailTo,
      emailError: "Missing SUMMARY_EMAIL_FROM or SMTP_FROM/SMTP_USER",
    }));
    return;
  }

  try {
    const info = await transport.sendMail({
      from: summaryEmailFrom,
      to: summaryEmailTo,
      subject: `Tenant screening summary: ${state.prospectName || "Unknown prospect"}`,
      text: buildEmailText(state),
    });

    saveState(callSid, (current) => ({
      ...current,
      emailStatus: "sent",
      emailTo: summaryEmailTo,
      emailMessageId: info.messageId || null,
      emailSentAt: new Date().toISOString(),
      emailError: null,
    }));
  } catch (error) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: "failed",
      emailTo: summaryEmailTo,
      emailError: error.message,
    }));
    console.error("Failed to send screening summary email:", error);
  }
}

function buildScreeningGoalSnapshot(state) {
  const currentGoalKey =
    state.currentGoalKey ||
    getNextOpenGoalKey(state.goals) ||
    SCREENING_GOALS[0].key;
  const currentGoal = getGoalByKey(currentGoalKey) || SCREENING_GOALS[0];
  const goalState = SCREENING_GOALS.map((goal) => ({
    goal: goal.key,
    label: goal.label,
    status: state.goals?.[goal.key]?.status || "open",
    notes: state.goals?.[goal.key]?.notes || "",
  }));

  return {
    prospect_name: state.prospectName || "unknown",
    property_name: state.propertyName || "unknown",
    current_goal: {
      key: currentGoal.key,
      label: currentGoal.label,
      guidance: currentGoal.guidance,
      status: state.goals?.[currentGoal.key]?.status || "open",
      notes: state.goals?.[currentGoal.key]?.notes || "",
    },
    completed_goals: goalState.filter((goal) => goal.status === "complete"),
    goal_state: goalState,
    latest_caller_transcript: state.lastUserMessage || null,
    last_question_asked: state.lastAgentMessage || null,
    prior_answers: (state.answers || []).slice(-5).map((answer) => ({
      goal: answer.goalKey,
      answer: answer.answer,
    })),
  };
}

function buildRealtimeInstructions(state) {
  const snapshot = buildScreeningGoalSnapshot(state);
  return [
    "You are conducting a live tenant screening phone interview over a real-time phone call.",
    "Keep the conversation warm, concise, natural, and lightly conversational.",
    "Wait for the caller to speak first before you say anything.",
    'When the caller first says hello or starts speaking, begin with a short identification line such as: "Hello, this is the screening assistant calling about your rental request. I just need a few quick questions." Pause briefly after that line before asking the first screening question.',
    "Use contractions and brief acknowledgements naturally when they fit, but do not ramble.",
    "Do not sound like a call-center script or a robotic IVR.",
    "If the caller makes a joke or light comment, you can smile in your voice, chuckle lightly, and respond like a normal person before steering back to the screening.",
    "Be friendly and human, but keep the call professional and on task.",
    "Ask exactly one question at a time.",
    "The caller audio may be imperfect, so if an answer seems partial or noisy, ask one short clarification instead of moving on.",
    "Do not ask about protected characteristics.",
    "Use the tools only when you have enough information to record a screening update or finish the screening.",
    "When the current goal is answered well enough, call record_screening_update before continuing.",
    "For move-in timing, an exact date like 'May 5th' already answers the timing question. Do not ask an early/mid/late follow-up if the caller already gave a specific calendar date.",
    "If the caller answers a clarification after already giving a specific detail, combine the new detail with the earlier answer instead of replacing it unless the caller clearly corrects themselves.",
    "For rental history, do not mark the goal complete until you know both the caller's recent housing context and whether they have landlord or personal references, or they clearly say they do not have references.",
    "Never say you are transferring, connecting, or handing the caller to a human. That is not available in this flow.",
    "If the caller says something strange, joking, or unclear, stay on script and ask one short clarifying question for the current goal.",
    "When all goals are complete, call finish_screening.",
    "If the caller refuses to continue or remains too unclear after a couple of brief clarifications, politely end the call by calling finish_screening with disposition set to unable_to_complete.",
    `Current call state: ${JSON.stringify(snapshot)}`,
  ].join("\n");
}

function buildOpenAISessionUpdate(state) {
  const turnDetection = {
    type: "server_vad",
    create_response: false,
    interrupt_response: true,
    idle_timeout_ms: openaiRealtimeIdleTimeoutMs,
    prefix_padding_ms: openaiRealtimePrefixPaddingMs,
    silence_duration_ms: openaiRealtimeSilenceDurationMs,
  };

  if (Number.isFinite(openaiRealtimeSpeechThreshold)) {
    turnDetection.threshold = openaiRealtimeSpeechThreshold;
  }

  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: buildRealtimeInstructions(state),
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: turnDetection,
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: openaiRealtimeInputLanguage,
          },
        },
        output: {
          format: { type: "audio/pcmu" },
          voice: openaiRealtimeVoice,
        },
      },
      tools: OPENAI_TOOLS,
    },
  };
}

function getRealtimeSession(callSid) {
  let session = realtimeSessions.get(callSid);
  if (session) {
    return session;
  }

  session = {
    callSid,
    streamSid: null,
    twilioSocket: null,
    openaiSocket: null,
    openaiReady: false,
    initialResponseSent: false,
    pendingTwilioAudio: [],
    pendingHangup: false,
    pendingMarkName: null,
    assistantSpeaking: false,
    closed: false,
    closeReason: null,
    lastResponseId: null,
    toolCallCounter: 0,
    handledToolCallIds: new Set(),
    responseInProgress: false,
    finalResponseDelivered: false,
    sawSpeechStopped: false,
    sawAudioCommitted: false,
    hangupTimer: null,
    responseDebounceTimer: null,
    callLog: [],
    callStartedAt: new Date(),
  };

  realtimeSessions.set(callSid, session);
  return session;
}

function callTag(session) {
  return `[call:${session.callSid?.slice(-6) || "???"}]`;
}

function looksIncomplete(transcript) {
  const t = transcript.toLowerCase().trim();
  if (!t) return false;

  // Ends with filler words or trailing connectors — user is mid-thought
  const trailingPatterns = /\b(uh|um|and|or|but|so|like|the|a|an|for|about|to|of|in|my|i|is|was|that|with|from|at|on|it|just|you know|i mean|well|basically|actually|i'm|i've|we|let me|i got|looking)\s*\.{0,3}$/;
  if (trailingPatterns.test(t)) return true;

  // Very short fragments (fewer than 4 real words) are likely incomplete
  const words = t.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 3 && !/[.!?]$/.test(t)) return true;

  return false;
}

function looksLikeVoicemailGreeting(transcript) {
  const t = transcript.toLowerCase().trim();
  if (!t) return false;

  const patterns = [
    /\bforwarded to voicemail\b/,
    /\bgo(?:ne)? to voicemail\b/,
    /\bnot available\b.*\b(record your message|leave (?:a )?message|at the tone)\b/,
    /\bafter the tone\b/,
    /\bat the tone\b/,
    /\bplease (?:leave|record) (?:a )?message\b/,
    /\bmailbox\b/,
    /\bvoice mailbox\b/,
    /\bgoogle voice subscriber\b/,
    /\bis not accepting calls\b/,
  ];

  return patterns.some((pattern) => pattern.test(t));
}

function clearResponseDebounce(session, reason = "") {
  if (!session.responseDebounceTimer) {
    return;
  }

  clearTimeout(session.responseDebounceTimer);
  session.responseDebounceTimer = null;

  if (reason) {
    logCall(session, `   cancelled pending response (${reason})`);
  }
}

function resetTurnCompletionFlags(session) {
  session.sawSpeechStopped = false;
  session.sawAudioCommitted = false;
  session.turnHadMeaningfulTranscript = false;
}

function scheduleResponseDebounce(session, label = "debounce") {
  if (session.responseDebounceTimer) {
    clearTimeout(session.responseDebounceTimer);
  }

  session.responseDebounceTimer = setTimeout(() => {
    session.responseDebounceTimer = null;
    if (session.pendingHangup) {
      logCall(session, `   ${label} skipped — call is already finalizing`);
      return;
    }
    if (!session.closed && !session.responseInProgress) {
      logCall(session, `   ${label} fired — sending response.create`);
      sendOpenAIJson(session, { type: "response.create" });
      session.responseInProgress = true;
      resetTurnCompletionFlags(session);
    }
  }, openaiRealtimeResponseDelayMs);
}

function maybeScheduleTurnResponse(session) {
  if (!session.sawSpeechStopped || !session.sawAudioCommitted) {
    return;
  }

  scheduleResponseDebounce(session, "debounce");
}

function logCall(session, message) {
  const ts = new Date().toISOString();
  console.log(`${callTag(session)} ${message}`);
  if (session.callLog) {
    session.callLog.push({ ts, message });
  }
}

function sendTwilioJson(session, payload) {
  if (
    !session.twilioSocket ||
    session.twilioSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (payload.event === "clear") {
    logCall(session, ">> twilio: clear audio buffer");
  } else if (payload.event === "mark") {
    logCall(session, `>> twilio: mark "${payload.mark?.name}"`);
  }

  session.twilioSocket.send(JSON.stringify(payload));
}

function sendOpenAIJson(session, payload) {
  if (
    !session.openaiSocket ||
    session.openaiSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  if (payload.type !== "input_audio_buffer.append") {
    logCall(session, `>> openai: ${payload.type}`);
  }

  session.openaiSocket.send(JSON.stringify(payload));
}

function flushPendingTwilioAudio(session) {
  if (
    !session.openaiSocket ||
    session.openaiSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  while (session.pendingTwilioAudio.length > 0) {
    const audio = session.pendingTwilioAudio.shift();
    sendOpenAIJson(session, {
      type: "input_audio_buffer.append",
      audio,
    });
  }
}

function formatCallLogEmail(session) {
  const state = getState(session.callSid) || {};
  const duration = session.callStartedAt
    ? Math.round((Date.now() - session.callStartedAt.getTime()) / 1000)
    : 0;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const lines = [];
  lines.push("═══════════════════════════════════════════════════");
  lines.push(`  CALL LOG: ${state.prospectName || "Unknown"}`);
  lines.push("═══════════════════════════════════════════════════");
  lines.push("");
  lines.push(`Call SID:     ${session.callSid}`);
  lines.push(`Prospect:     ${state.prospectName || "unknown"}`);
  lines.push(`Property:     ${state.propertyName || "unknown"}`);
  lines.push(`Duration:     ${mins}m ${secs}s`);
  lines.push(`Status:       ${state.status || "unknown"}`);
  lines.push(`End reason:   ${session.closeReason || state.endReason || "unknown"}`);
  lines.push(`Started:      ${session.callStartedAt?.toISOString() || "?"}`);
  lines.push(`Ended:        ${new Date().toISOString()}`);
  lines.push("");

  // Screening results
  if (state.answers && state.answers.length > 0) {
    lines.push("───────────────────────────────────────────────────");
    lines.push("  SCREENING RESULTS");
    lines.push("───────────────────────────────────────────────────");
    for (const answer of state.answers) {
      const label = answer.goalLabel || answer.goalKey || `Q${answer.questionNumber}`;
      lines.push(`  ${label}: ${answer.answer}`);
    }
    if (state.summary) {
      lines.push("");
      lines.push(`  Summary: ${state.summary}`);
    }
    lines.push("");
  }

  // Event timeline
  lines.push("───────────────────────────────────────────────────");
  lines.push("  EVENT TIMELINE");
  lines.push("───────────────────────────────────────────────────");
  for (const entry of session.callLog || []) {
    const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm
    const msg = entry.message;

    // Add visual markers for key events
    let prefix = "  ";
    if (msg.includes("user transcript:")) prefix = "🎤";
    else if (msg.includes("agent said:")) prefix = "🔊";
    else if (msg.includes("tool:") && msg.includes("handling")) prefix = "🔧";
    else if (msg.includes("interrupting")) prefix = "⚡";
    else if (msg.includes("ERROR")) prefix = "❌";

    lines.push(`${prefix} ${time}  ${msg}`);
  }
  lines.push("");
  lines.push("═══════════════════════════════════════════════════");

  return lines.join("\n");
}

async function sendCallLogEmail(session) {
  try {
    const transport = createMailTransport();
    if (!transport) return;
    if (!summaryEmailFrom) return;

    const state = getState(session.callSid) || {};
    const prospect = state.prospectName || "Unknown";
    const status = state.status || "unknown";

    await transport.sendMail({
      from: summaryEmailFrom,
      to: summaryEmailTo,
      subject: `Call log: ${prospect} [${status}]`,
      text: formatCallLogEmail(session),
    });
  } catch (error) {
    console.error("Failed to send call log email:", error);
  }
}

function closeRealtimeSession(callSid, reason) {
  const session = realtimeSessions.get(callSid);
  if (!session || session.closed) {
    return;
  }

  logCall(session, `closing session reason="${reason}"`);
  session.closed = true;
  session.closeReason = reason || session.closeReason || null;

  if (session.hangupTimer) {
    clearTimeout(session.hangupTimer);
    session.hangupTimer = null;
  }

  if (session.responseDebounceTimer) {
    clearTimeout(session.responseDebounceTimer);
    session.responseDebounceTimer = null;
  }

  if (
    session.openaiSocket &&
    session.openaiSocket.readyState === WebSocket.OPEN
  ) {
    session.openaiSocket.close();
  }

  if (
    session.twilioSocket &&
    session.twilioSocket.readyState === WebSocket.OPEN
  ) {
    session.twilioSocket.close();
  }

  void sendCallLogEmail(session);
  realtimeSessions.delete(callSid);
}

function scheduleHangup(callSid, delayMs = 1200) {
  const session = realtimeSessions.get(callSid);
  if (!session || session.hangupTimer) {
    return;
  }

  logCall(session, `scheduling hangup in ${delayMs}ms`);
  session.hangupTimer = setTimeout(async () => {
    session.hangupTimer = null;
    logCall(session, "executing hangup");
    try {
      await twilioClient.calls(callSid).update({ status: "completed" });
    } catch (error) {
      console.error(`[call:${callSid.slice(-6)}] failed to hang up:`, error);
    }
  }, delayMs);
}

function updateGoalFromTool(callSid, args) {
  const goalKey = getGoalByKey(args.goal) ? args.goal : null;
  if (!goalKey) {
    throw new Error(`Unknown goal: ${args.goal}`);
  }

  return saveState(callSid, (current) => {
    const nextGoals = { ...(current.goals || createGoalState()) };
    const now = new Date().toISOString();
    const status = normalizeGoalStatus(args.status);
    const answer = normalizeText(args.captured_answer || "");
    const notes = normalizeText(args.notes || answer || "");
    const currentGoalKey =
      current.currentGoalKey ||
      getNextOpenGoalKey(nextGoals) ||
      goalKey ||
      SCREENING_GOALS[0].key;
    const nextAnswers = Array.isArray(current.answers)
      ? [...current.answers]
      : [];

    nextGoals[goalKey] = {
      status,
      notes,
      updatedAt: now,
    };

    if (answer) {
      nextAnswers.push({
        questionNumber: nextAnswers.length + 1,
        goalKey,
        goalLabel: getGoalByKey(goalKey)?.label || goalKey,
        answer,
        rawTranscript: current.lastUserMessage || "",
        receivedAt: now,
      });
    }

    const remainingGoalKey = getNextOpenGoalKey(nextGoals);
    const completed = remainingGoalKey === null;
    const nextGoalKey =
      normalizeText(args.next_goal || "") && getGoalByKey(args.next_goal)
        ? args.next_goal
        : remainingGoalKey || currentGoalKey;

    return {
      ...current,
      currentGoalKey: completed ? currentGoalKey : nextGoalKey,
      goals: nextGoals,
      answers: nextAnswers,
      status: completed ? "completed" : "active",
      endReason: completed ? null : current.endReason || null,
      completedAt: completed ? now : current.completedAt || null,
      emailStatus: completed ? "pending" : current.emailStatus || null,
      lastError: null,
      lastPrompt: JSON.stringify({ tool: "record_screening_update", args }),
    };
  });
}

function finishScreening(callSid, args) {
  const now = new Date().toISOString();
  const state = saveState(callSid, (current) => ({
    ...current,
    status: "completed",
    summary: normalizeText(args.summary) || current.summary || "",
    endReason: normalizeText(args.disposition) || "complete",
    completedAt: now,
    emailStatus: "pending",
    lastError: null,
    lastPrompt: JSON.stringify({ tool: "finish_screening", args }),
  }));

  void sendSummaryEmail(callSid);
  return state;
}

function escalateToHuman(callSid, args) {
  const now = new Date().toISOString();
  const state = saveState(callSid, (current) => ({
    ...current,
    status: "failed",
    summary: normalizeText(args.summary) || current.summary || "",
    endReason: "escalated_to_human",
    completedAt: now,
    emailStatus: "pending",
    lastError: normalizeText(args.reason) || "Escalated to human.",
    lastPrompt: JSON.stringify({ tool: "escalate_to_human", args }),
  }));

  void sendSummaryEmail(callSid);
  return state;
}

async function handleOpenAIToolCall(session, callId, name, argumentsText) {
  if (callId && session.handledToolCallIds.has(callId)) {
    logCall(session, `tool: skipping duplicate call_id=${callId} "${name}"`);
    return;
  }
  if (callId) {
    session.handledToolCallIds.add(callId);
  }

  const callSid = session.callSid;
  const rawArgs = normalizeText(argumentsText || "{}");
  let args;

  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    args = {};
  }

  logCall(session, `tool: handling "${name}" args=${JSON.stringify(args)}`);

  let state;
  let output = null;

  try {
    if (name === "record_screening_update") {
      state = updateGoalFromTool(callSid, args);
      logCall(session, `tool: record_screening_update goal=${args.goal} status=${args.status} -> screening=${state.status} nextGoal=${state.currentGoalKey}`);
      if (state.status === "completed") {
        logCall(session, `tool: all goals complete, pending hangup`);
        session.pendingHangup = true;
      }
      output = {
        ok: true,
        callSid,
        state: {
          status: state.status,
          currentGoalKey: state.currentGoalKey,
          nextOpenGoalKey: getNextOpenGoalKey(state.goals),
          goals: state.goals,
        },
      };
    } else if (name === "finish_screening") {
      state = finishScreening(callSid, args);
      logCall(session, `tool: finish_screening disposition=${args.disposition}`);
      session.pendingHangup = true;
      output = {
        ok: true,
        callSid,
        state: {
          status: state.status,
          summary: state.summary,
          endReason: state.endReason,
        },
      };
    } else if (name === "escalate_to_human") {
      logCall(session, `tool: escalate_to_human requested but disabled; converting to unable_to_complete`);
      state = finishScreening(callSid, {
        summary:
          normalizeText(args.summary) ||
          "Screening could not be completed automatically.",
        disposition: "unable_to_complete",
      });
      session.pendingHangup = true;
      output = {
        ok: true,
        callSid,
        state: {
          status: state.status,
          summary: state.summary,
          endReason: state.endReason,
        },
      };
    } else {
      logCall(session, `tool: unknown tool "${name}"`);
      output = {
        ok: false,
        error: `Unknown tool call: ${name}`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCall(session, `tool: ${name} failed: ${message}`);
    saveState(callSid, (current) => ({
      ...current,
      lastError: message,
      lastPrompt: JSON.stringify({ tool: name, args, error: message }),
    }));
    output = {
      ok: false,
      error: message,
      retryable: true,
      tool: name,
    };
  }

  if (
    session.openaiSocket &&
    session.openaiSocket.readyState === WebSocket.OPEN
  ) {
    session.openaiSocket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      }),
    );
    if (!session.responseInProgress) {
      logCall(session, `tool: sending response.create after tool result`);
      session.openaiSocket.send(JSON.stringify({ type: "response.create" }));
      session.responseInProgress = true;
    } else {
      logCall(session, `tool: skipping response.create — response already in progress`);
    }
  }
}

async function initializeOpenAISession(session) {
  if (session.initialResponseSent) {
    logCall(session, "openai: init skipped (already sent)");
    return;
  }

  const state =
    getState(session.callSid) ||
    (await createInterviewSession(
      session.callSid,
      session.prospectName || "",
      session.propertyName || "",
    ));

  logCall(session, `openai: sending session.update (goal=${state.currentGoalKey}, status=${state.status})`);
  sendOpenAIJson(session, buildOpenAISessionUpdate(state));
  session.initialResponseSent = true;
}

function handleOpenAIEvent(session, payload) {
  const tag = callTag(session);

  switch (payload.type) {
    case "session.created":
      logCall(session, `<< openai: session.created`);
      break;
    case "session.updated":
      logCall(session, `<< openai: session.updated`);
      break;
    case "response.created":
      logCall(session, `<< openai: response.created id=${payload.response?.id || "?"} (was inProgress=${session.responseInProgress})`);
      session.responseInProgress = true;
      session.lastResponseId =
        payload.response?.id || payload.response_id || session.lastResponseId;
      break;
    case "input_audio_buffer.speech_started":
      logCall(session, `<< openai: speech_started (assistantSpeaking=${session.assistantSpeaking}, responseInProgress=${session.responseInProgress})`);
      // User started talking — cancel any pending debounced response
      clearResponseDebounce(session, "user still talking");
      resetTurnCompletionFlags(session);
      if (session.assistantSpeaking || session.responseInProgress) {
        logCall(session, "   interrupting — sending response.cancel + clear");
        sendOpenAIJson(session, { type: "response.cancel" });
        sendTwilioJson(session, {
          event: "clear",
          streamSid: session.streamSid,
        });
        session.assistantSpeaking = false;
      }
      break;
    case "input_audio_buffer.speech_stopped":
      logCall(session, "<< openai: speech_stopped");
      session.sawSpeechStopped = true;
      maybeScheduleTurnResponse(session);
      break;
    case "input_audio_buffer.committed":
      logCall(session, "<< openai: audio_buffer.committed");
      session.sawAudioCommitted = true;
      maybeScheduleTurnResponse(session);
      break;
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = (payload.transcript || "").trim();
      logCall(session, `<< openai: user transcript: "${transcript}"`);
      if (transcript) {
        appendRunEvent(session.callSid, "transcript.user", {
          text: transcript,
          currentGoalKey: session.currentGoalKey || null,
        });
        if (transcript.length > 2) {
          session.turnHadMeaningfulTranscript = true;
        }
      }
      if (transcript.length <= 2) {
        if (session.turnHadMeaningfulTranscript) {
          logCall(session, "   empty/noise transcript after a real user turn — ignoring");
          break;
        }
        logCall(session, "   empty/noise transcript — cancelling response + clearing twilio buffer");
        clearResponseDebounce(session, "empty/noise transcript");
        resetTurnCompletionFlags(session);
        if (session.responseInProgress) {
          sendOpenAIJson(session, { type: "response.cancel" });
        }
        // Clear audio already queued in Twilio so the user doesn't hear
        // a partial "I didn't catch that" from the noise-triggered response
        sendTwilioJson(session, { event: "clear", streamSid: session.streamSid });
        session.assistantSpeaking = false;
        break;
      }
      if (looksLikeVoicemailGreeting(transcript)) {
        logCall(session, "   voicemail greeting detected — terminating call");
        clearResponseDebounce(session, "voicemail greeting detected");
        resetTurnCompletionFlags(session);
        if (session.responseInProgress) {
          sendOpenAIJson(session, { type: "response.cancel" });
        }
        sendTwilioJson(session, { event: "clear", streamSid: session.streamSid });
        session.assistantSpeaking = false;
        session.pendingHangup = true;
        session.finalResponseDelivered = true;
        saveState(session.callSid, (current) => ({
          ...current,
          status: "terminated",
          endReason: "voicemail_detected",
          completedAt: current.completedAt || new Date().toISOString(),
          lastError: null,
          lastUserMessage: transcript,
        }));
        scheduleHangup(session.callSid, 250);
        break;
      }
      // If the transcript looks incomplete (filler words, trailing off)
      // and we have a debounce timer pending, extend it to give the user
      // more time to finish their thought.
      if (looksIncomplete(transcript) && session.responseDebounceTimer) {
        clearResponseDebounce(session);
        const extendedDelay = openaiRealtimeResponseDelayMs * 2;
        logCall(session, `   incomplete transcript detected — extending debounce to ${extendedDelay}ms`);
        session.responseDebounceTimer = setTimeout(() => {
          session.responseDebounceTimer = null;
          if (session.pendingHangup) {
            logCall(session, "   extended debounce skipped — call is already finalizing");
            return;
          }
          if (!session.closed && !session.responseInProgress) {
            logCall(session, "   extended debounce fired — sending response.create");
            sendOpenAIJson(session, { type: "response.create" });
            session.responseInProgress = true;
            resetTurnCompletionFlags(session);
          }
        }, extendedDelay);
      }
      saveState(session.callSid, (current) => ({
        ...current,
        lastUserMessage: transcript,
      }));
      break;
    }
    case "response.output_audio.delta":
    case "response.audio.delta":
      if (payload.delta) {
        sendTwilioJson(session, {
          event: "media",
          streamSid: session.streamSid,
          media: {
            payload: payload.delta,
          },
        });
        if (!session.assistantSpeaking) {
          logCall(session, `<< openai: audio streaming started (response=${payload.response_id || "?"})`);
        }
        session.assistantSpeaking = true;
      }
      break;
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      if (payload.transcript) {
        logCall(session, `<< openai: agent said: "${payload.transcript}"`);
        appendRunEvent(session.callSid, "transcript.agent", {
          text: payload.transcript,
          currentGoalKey: session.currentGoalKey || null,
        });
        if (session.pendingHangup) {
          session.finalResponseDelivered = true;
        }
        saveState(session.callSid, (current) => ({
          ...current,
          lastAgentMessage: payload.transcript,
          lastPrompt: JSON.stringify({
            response_id: payload.response_id || null,
            transcript: payload.transcript,
          }),
        }));
      }
      break;
    case "response.output_audio.done":
    case "response.audio.done":
      logCall(session, `<< openai: audio done (pendingHangup=${session.pendingHangup})`);
      if (session.pendingHangup) {
        const markName = `final-${payload.response_id || Date.now()}`;
        session.pendingMarkName = markName;
        sendTwilioJson(session, {
          event: "mark",
          streamSid: session.streamSid,
          mark: {
            name: markName,
          },
        });
      }
      session.assistantSpeaking = false;
      break;
    case "response.function_call_arguments.done":
      logCall(session, `<< openai: tool call "${payload.name}" (call_id=${payload.call_id || "?"})`);
      void handleOpenAIToolCall(
        session,
        payload.call_id,
        payload.name,
        payload.arguments,
      );
      break;
    case "response.output_item.done":
      if (payload.item?.type === "function_call") {
        logCall(session, `<< openai: tool call (output_item) "${payload.item.name}" (call_id=${payload.item.call_id || payload.item.id || "?"})`);
        void handleOpenAIToolCall(
          session,
          payload.item.call_id || payload.item.id,
          payload.item.name,
          payload.item.arguments || payload.item.arguments_json || "{}",
        );
      }
      break;
    case "response.done": {
      const outputs = payload.response?.output || [];
      const outputTypes = outputs.map((o) => o.type).join(", ") || "none";
      logCall(session, `<< openai: response.done id=${payload.response?.id || "?"} outputs=[${outputTypes}]`);
      session.assistantSpeaking = false;
      session.responseInProgress = false;
      session.lastResponseId = null;

      // If the model used any tool call in this turn, explicitly request a
      // follow-up so the agent continues the screening instead of stalling.
      const hasFunctionCall = outputs.some((o) => o.type === "function_call");
      if (hasFunctionCall && !session.closed) {
        if (session.pendingHangup && session.finalResponseDelivered) {
          logCall(session, "   tool response — skipping follow-up because final response was already delivered");
          break;
        }
        logCall(session, `   tool response — sending response.create for follow-up`);
        sendOpenAIJson(session, { type: "response.create" });
        session.responseInProgress = true;
      }
      break;
    }
    case "error":
      if (payload.error?.code === "response_cancel_not_active") {
        logCall(session, `<< openai: cancel-not-active (harmless race, resetting state)`);
        session.assistantSpeaking = false;
        session.responseInProgress = false;
        return;
      }
      logCall(session, `<< openai: ERROR ${JSON.stringify(payload.error)}`);
      console.error(`${tag} << openai: ERROR`, payload.error);
      session.responseInProgress = false;
      session.lastResponseId = null;
      saveState(session.callSid, (current) => ({
        ...current,
        status: "failed",
        lastError:
          payload.error?.message ||
          payload.error?.toString?.() ||
          "OpenAI realtime error",
      }));
      scheduleHangup(session.callSid, 1200);
      break;
    default:
      break;
  }
}

async function anthropicJson(apiPath, body) {
  const response = await fetch(`https://api.anthropic.com/v1${apiPath}`, {
    method: body ? "POST" : "GET",
    headers: {
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "managed-agents-2026-04-01",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${text}`);
  }

  return response.json();
}

async function createInterviewSession(callSid, prospectName, propertyName) {
  const now = new Date().toISOString();
  const state = {
    callSid,
    prospectName: normalizeText(prospectName),
    propertyName: normalizeText(propertyName),
    turn: 0,
    currentGoalKey: SCREENING_GOALS[0].key,
    goals: createGoalState(),
    unclearAttempts: 0,
    answers: [],
    summary: "",
    status: "active",
    endReason: null,
    createdAt: now,
    updatedAt: now,
    lastPrompt: "",
    lastAgentMessage: "",
    lastUserMessage: "",
    lastError: null,
    openaiSessionId: null,
    streamSid: null,
    assistantSpeaking: false,
    pendingHangup: false,
    pendingResponseId: null,
    pendingMarkName: null,
    turnHadMeaningfulTranscript: false,
  };

  callState.set(callSid, state);
  persistStateStore();
  appendRunEvent(callSid, "session.created", {
    prospectName: state.prospectName || null,
    propertyName: state.propertyName || null,
    status: state.status,
  });
  return state;
}

function buildTurnPrompt(state, callerText) {
  const currentGoalKey =
    state.currentGoalKey ||
    getNextOpenGoalKey(state.goals) ||
    SCREENING_GOALS[0].key;
  const currentGoal = getGoalByKey(currentGoalKey) || SCREENING_GOALS[0];
  const goalStateSummary = SCREENING_GOALS.map((goal) => ({
    goal: goal.key,
    label: goal.label,
    status: state.goals?.[goal.key]?.status || "open",
    notes: state.goals?.[goal.key]?.notes || "",
  }));

  const payload = {
    prospectName: state.prospectName || "unknown",
    propertyName: state.propertyName || "unknown",
    currentGoal: {
      key: currentGoal.key,
      label: currentGoal.label,
      guidance: currentGoal.guidance,
    },
    completedGoals: goalStateSummary.filter(
      (goal) => goal.status === "complete",
    ),
    goalState: goalStateSummary,
    latestCallerTranscript: callerText || null,
    lastQuestionAsked: state.lastAgentMessage || null,
    priorCapturedAnswers: state.answers || [],
  };

  return [
    "You are conducting a live tenant screening phone interview.",
    "The speech transcript may be imperfect because it comes from a phone call.",
    "Your job is to decide whether the latest caller transcript sufficiently answers the current goal, whether to ask a clarifying follow-up, or whether to move to the next goal.",
    "Be conversational, warm, and natural, not robotic.",
    "Use short, human-sounding phrasing with contractions and occasional brief acknowledgements when appropriate.",
    "If the caller makes a joke or light comment, you can smile in your voice, chuckle lightly, and respond like a normal person before steering back to the screening.",
    "Be friendly and human, but keep the call professional and on task.",
    "Ask exactly one question at a time.",
    "Keep spoken questions short and natural for phone audio.",
    "Do not ask about protected characteristics.",
    "If the transcript is partial but useful, capture what you can and ask a focused follow-up.",
    "If the caller gave an exact move-in date like 'May 5th', treat the move-in timing as specific enough and do not downgrade it to early/mid/late.",
    "When a follow-up answer adds detail, combine it with the existing answer state. Do not overwrite an earlier exact date unless the caller clearly states a different date.",
    "For rental_history_references, do not mark it complete unless the answer covers both recent housing/rental context and whether the caller has references, or clearly states they do not have references.",
    "Return only valid JSON with this exact shape:",
    '{"next_action":"ask_followup|ask_next_goal|complete_screening","spoken_response":"string","captured_answer":"string","goal_updates":[{"goal":"employment_income|move_in_timeline|rental_history_references","status":"open|partial|complete","notes":"string"}],"reviewer_summary":"string"}',
    "Set reviewer_summary only when all goals are complete. Otherwise return an empty string for reviewer_summary.",
    `Current call state: ${JSON.stringify(payload)}`,
  ].join("\n");
}

function extractTextFromAgentMessage(messageEvent) {
  const content = messageEvent?.content || [];
  return content
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function sendSessionMessage(sessionId, text) {
  await anthropicJson(`/sessions/${sessionId}/events`, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text }],
      },
    ],
  });
}

async function listSessionEvents(sessionId) {
  const response = await fetch(
    `https://api.anthropic.com/v1/sessions/${sessionId}/events?beta=true`,
    {
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "managed-agents-2026-04-01",
        accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic events API ${response.status}: ${text}`);
  }

  const payload = await response.json();
  return payload.data || [];
}

async function waitForAgentReply(sessionId, previousCount) {
  const deadline = Date.now() + agentReplyTimeoutMs;
  while (Date.now() < deadline) {
    const events = await listSessionEvents(sessionId);
    const agentMessages = events.filter(
      (event) => event.type === "agent.message",
    );
    if (agentMessages.length > previousCount) {
      return {
        message: agentMessages[agentMessages.length - 1],
        count: agentMessages.length,
      };
    }
    await new Promise((resolve) =>
      setTimeout(resolve, agentReplyPollIntervalMs),
    );
  }
  throw new Error("Timed out waiting for agent reply");
}

function connectOpenAIRealtime(session) {
  if (
    session.openaiSocket &&
    session.openaiSocket.readyState === WebSocket.OPEN
  ) {
    return session.openaiSocket;
  }

  const realtimeUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(openaiRealtimeModel)}`;
  const socket = new WebSocket(realtimeUrl, {
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
    },
  });

  session.openaiSocket = socket;

  socket.on("open", () => {
    logCall(session, `openai: websocket connected`);
    session.openaiReady = true;
    initializeOpenAISession(session).catch((error) => {
      console.error(
        `${callTag(session)} openai: failed to initialize session:`,
        error,
      );
      saveState(session.callSid, (current) => ({
        ...current,
        status: "failed",
        lastError: error.message,
      }));
      scheduleHangup(session.callSid, 1200);
    });
    flushPendingTwilioAudio(session);
  });

  socket.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      handleOpenAIEvent(session, payload);
    } catch (error) {
      console.error(
        `${callTag(session)} openai: failed to parse message:`,
        error,
      );
    }
  });

  socket.on("error", (error) => {
    console.error(`${callTag(session)} openai: socket error:`, error);
    saveState(session.callSid, (current) => ({
      ...current,
      status: "failed",
      lastError: error.message,
    }));
    scheduleHangup(session.callSid, 1200);
  });

  socket.on("close", () => {
    logCall(session, `openai: websocket closed`);
    session.openaiReady = false;
    if (!session.closed) {
      scheduleHangup(session.callSid, 1200);
    }
  });

  return socket;
}

function validateTwilioRequest(req) {
  if (process.env.VALIDATE_TWILIO_WEBHOOKS !== "true") {
    return true;
  }

  const signature = req.get("X-Twilio-Signature") || "";
  const externalBaseUrl = appBaseUrl || `${req.protocol}://${req.get("host")}`;
  const url = `${externalBaseUrl}${req.originalUrl}`;
  return twilio.validateRequest(twilioAuthToken, signature, url, req.body);
}

function extractTwilioParameters(message) {
  const start = message?.start || {};
  const custom = start.customParameters || {};
  const callSid =
    normalizeText(message?.callSid) ||
    normalizeText(start.callSid) ||
    normalizeText(custom.callSid) ||
    normalizeText(custom.CallSid) ||
    "";

  return {
    callSid,
    prospectName:
      normalizeText(custom.prospectName) ||
      normalizeText(custom.prospect_name) ||
      normalizeText(start.prospectName) ||
      "",
    propertyName:
      normalizeText(custom.propertyName) ||
      normalizeText(custom.property_name) ||
      normalizeText(start.propertyName) ||
      "",
  };
}

function parseRequestText(req) {
  return normalizeText(req.body.SpeechResult || req.body.Digits || "");
}

function parseSpeechConfidence(req) {
  const value = req.body?.Confidence ?? req.body?.confidence;
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeNonAnswer(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return true;
  }

  const exactPhrases = new Set([
    "hello",
    "hi",
    "hey",
    "what",
    "pardon",
    "sorry",
    "repeat that",
    "say that again",
  ]);

  if (exactPhrases.has(normalized)) {
    return true;
  }

  const patterns = [
    /\b(can you|could you|would you)\s+(repeat|say that again)\b/,
    /\b(i|you)\s+(didn't|did not|cant|can't)\s+(hear|catch)\b/,
    /\b(cut out|breaking up|hard to hear|say that again)\b/,
    /\bwhat was the question\b/,
    /\brepeat (the )?question\b/,
    /\bstart over\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function registerUnclearAttempt(callSid) {
  return saveState(callSid, (current) => {
    const unclearAttempts = (current.unclearAttempts || 0) + 1;
    const exhausted = unclearAttempts >= maxUnclearAttempts;
    return {
      ...current,
      unclearAttempts,
      status: exhausted ? "terminated" : current.status,
      endReason: exhausted
        ? "too_many_unclear_responses"
        : current.endReason || null,
      completedAt: exhausted
        ? new Date().toISOString()
        : current.completedAt || null,
      lastError: exhausted
        ? "Too many unclear responses."
        : current.lastError || null,
    };
  });
}

function createGoalState() {
  return Object.fromEntries(
    SCREENING_GOALS.map((goal) => [
      goal.key,
      { status: "open", notes: "", updatedAt: null },
    ]),
  );
}

function getGoalByKey(goalKey) {
  return SCREENING_GOALS.find((goal) => goal.key === goalKey) || null;
}

function getNextOpenGoalKey(goals) {
  for (const goal of SCREENING_GOALS) {
    if ((goals?.[goal.key]?.status || "open") !== "complete") {
      return goal.key;
    }
  }
  return null;
}

function normalizeGoalStatus(value) {
  return value === "complete" || value === "partial" ? value : "open";
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseAgentTurnResponse(rawText, state) {
  const fallbackGoalKey =
    state.currentGoalKey ||
    getNextOpenGoalKey(state.goals) ||
    SCREENING_GOALS[0].key;
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== "object") {
    return {
      nextAction: "ask_followup",
      spokenResponse:
        normalizeText(rawText) || "Could you tell me a little more about that?",
      capturedAnswer: "",
      reviewerSummary: "",
      goalUpdates: [],
    };
  }

  const nextAction =
    parsed.next_action === "ask_next_goal" ||
    parsed.next_action === "complete_screening" ||
    parsed.next_action === "ask_followup"
      ? parsed.next_action
      : "ask_followup";

  const spokenResponse = normalizeText(parsed.spoken_response || "");
  const capturedAnswer = normalizeText(parsed.captured_answer || "");
  const reviewerSummary = normalizeText(parsed.reviewer_summary || "");
  const goalUpdates = Array.isArray(parsed.goal_updates)
    ? parsed.goal_updates
        .map((update) => {
          const goalKey = normalizeText(update?.goal || "");
          if (!getGoalByKey(goalKey)) {
            return null;
          }
          return {
            goal: goalKey,
            status: normalizeGoalStatus(update?.status),
            notes: normalizeText(update?.notes || ""),
          };
        })
        .filter(Boolean)
    : [];

  if (
    capturedAnswer &&
    !goalUpdates.some((update) => update.goal === fallbackGoalKey)
  ) {
    goalUpdates.push({
      goal: fallbackGoalKey,
      status: nextAction === "ask_followup" ? "partial" : "complete",
      notes: capturedAnswer,
    });
  }

  return {
    nextAction,
    spokenResponse:
      spokenResponse ||
      (nextAction === "complete_screening"
        ? "Thank you. That gives us what we need."
        : "Could you tell me a little more about that?"),
    capturedAnswer,
    reviewerSummary,
    goalUpdates,
  };
}

function getProspectAndProperty(req) {
  return {
    prospectName: normalizeText(
      req.query.prospectName || req.body.prospectName || "",
    ),
    propertyName: normalizeText(
      req.query.propertyName || req.body.propertyName || "",
    ),
  };
}

async function advanceInterview(
  callSid,
  callerText,
  prospectName,
  propertyName,
) {
  let state = getState(callSid);
  if (!state) {
    state = await createInterviewSession(callSid, prospectName, propertyName);
  }

  const userText = normalizeText(callerText);

  if (isTerminalState(state)) {
    return state.lastAgentMessage || state.summary || "Thank you. Goodbye.";
  }

  const prompt = buildTurnPrompt(state, userText);
  const priorAgentMessages = state.agentMessageCount || 0;
  await sendSessionMessage(state.sessionId, prompt);
  const reply = await waitForAgentReply(state.sessionId, priorAgentMessages);
  const replyText =
    extractTextFromAgentMessage(reply.message) || "Thank you. Goodbye.";
  const agentTurn = parseAgentTurnResponse(replyText, state);

  const nextState = saveState(callSid, (current) => {
    const currentGoalKey =
      current.currentGoalKey ||
      getNextOpenGoalKey(current.goals) ||
      SCREENING_GOALS[0].key;
    const nextGoals = { ...(current.goals || createGoalState()) };

    for (const update of agentTurn.goalUpdates) {
      nextGoals[update.goal] = {
        status: update.status,
        notes: update.notes || nextGoals[update.goal]?.notes || "",
        updatedAt: new Date().toISOString(),
      };
    }

    const remainingGoalKey = getNextOpenGoalKey(nextGoals);
    const completed =
      agentTurn.nextAction === "complete_screening" ||
      remainingGoalKey === null;
    const nextCurrentGoalKey = completed
      ? currentGoalKey
      : remainingGoalKey || currentGoalKey;
    const nextAnswers = Array.isArray(current.answers)
      ? [...current.answers]
      : [];

    if (userText && agentTurn.capturedAnswer) {
      nextAnswers.push({
        questionNumber: nextAnswers.length + 1,
        goalKey: currentGoalKey,
        goalLabel: getGoalByKey(currentGoalKey)?.label || currentGoalKey,
        answer: agentTurn.capturedAnswer,
        rawTranscript: userText,
        receivedAt: new Date().toISOString(),
      });
    }

    return {
      ...current,
      turn: (current.turn || 0) + 1,
      currentGoalKey: nextCurrentGoalKey,
      goals: nextGoals,
      answers: nextAnswers,
      agentMessageCount: reply.count,
      lastUserMessage: userText || current.lastUserMessage || "",
      unclearAttempts: userText ? 0 : current.unclearAttempts || 0,
      lastPrompt: prompt,
      lastAgentMessage: agentTurn.spokenResponse,
      summary: completed
        ? agentTurn.reviewerSummary || current.summary || ""
        : current.summary || "",
      status: completed ? "completed" : "active",
      endReason: completed ? null : current.endReason || null,
      completedAt: completed
        ? new Date().toISOString()
        : current.completedAt || null,
      emailStatus: completed ? "pending" : current.emailStatus || null,
      lastError: null,
    };
  });

  if (nextState.status === "completed") {
    void sendSummaryEmail(callSid);
  }

  return nextState.lastAgentMessage || agentTurn.spokenResponse || replyText;
}

app.get("/health", (_req, res) => {
  const runtime = loadRuntimeConfig();
  res.json({
    ok: true,
    provider: "openai-realtime",
    model: openaiRealtimeModel,
    voice: openaiRealtimeVoice,
    idleTimeoutMs: openaiRealtimeIdleTimeoutMs,
    fallbackVoice,
    defaultFromNumber,
    publicBaseUrl: runtime?.appBaseUrl || runtime?.publicBaseUrl || null,
    statePath,
  });
});

app.get("/dashboard", (req, res) => {
  if (!requireDashboardAuth(req, res)) {
    return;
  }

  res.type("html").send(renderDashboardPage());
});

app.get("/dashboard/api/runs", (req, res) => {
  if (!requireDashboardAuth(req, res)) {
    return;
  }

  const limit = parseLimitParam(req.query.limit, 50, 200);
  const status = normalizeText(req.query.status || "");
  const runs = listRunSummaries({ limit, status });
  const allRuns = Array.from(callState.values());
  const lastUpdatedAt =
    allRuns
      .map((state) => state?.updatedAt || state?.createdAt || null)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

  res.json({
    runs,
    stats: {
      totalRuns: allRuns.length,
      activeRuns: allRuns.filter((state) => state?.status === "active").length,
      completedRuns: allRuns.filter((state) => state?.status === "completed").length,
      failedRuns: allRuns.filter((state) => state?.status === "failed").length,
      terminatedRuns: allRuns.filter((state) => state?.status === "terminated").length,
      lastUpdatedAt,
      eventLogPath,
    },
  });
});

app.get("/dashboard/api/runs/:callSid", (req, res) => {
  if (!requireDashboardAuth(req, res)) {
    return;
  }

  const callSid = req.params.callSid;
  const state = getState(callSid);
  if (!state) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  res.json({
    run: summarizeRun(state),
    state,
  });
});

app.get("/dashboard/api/runs/:callSid/logs", (req, res) => {
  if (!requireDashboardAuth(req, res)) {
    return;
  }

  const callSid = req.params.callSid;
  const state = getState(callSid);
  if (!state) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const limit = parseLimitParam(req.query.limit, 200, 500);
  res.json({
    callSid,
    events: readRunEvents({ callSid, limit }),
  });
});

app.get("/testing", (_req, res) => {
  res.type("html").send(renderTestingPage());
});

app.post("/testing/start", async (req, res) => {
  try {
    const callParams = buildOutboundCallParams(req.body || {});
    const call = await twilioClient.calls.create(callParams);
    appendRunEvent(call.sid, "testing.call.created", {
      to: call.to || null,
      from: call.from || null,
      status: call.status || null,
      prospectName: normalizeText(req.body?.prospectName) || null,
      propertyName: normalizeText(req.body?.propertyName) || null,
    });
    const structuredContent = {
      callSid: call.sid,
      accountSid: call.accountSid,
      to: call.to,
      from: call.from,
      status: call.status,
      direction: call.direction ?? null,
      prospectName: normalizeText(req.body?.prospectName) || null,
      propertyName: normalizeText(req.body?.propertyName) || null,
      screeningUrl: callParams.url ?? null,
      record: callParams.record,
    };

    res.status(201).json(structuredContent);
  } catch (error) {
    console.error("Failed to start testing call:", error);
    res
      .status(400)
      .json({ error: error.message || "Failed to start the call." });
  }
});

app.post("/voice/start", async (req, res) => {
  if (!validateTwilioRequest(req)) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }

  try {
    const callSid = req.body.CallSid;
    if (!callSid) {
      res.status(400).type("text/plain").send("Missing CallSid");
      return;
    }

    const { prospectName, propertyName } = getProspectAndProperty(req);
    let state = getState(callSid);
    if (!state) {
      state = await createInterviewSession(callSid, prospectName, propertyName);
    }
    appendRunEvent(callSid, "voice.start", {
      prospectName: state.prospectName || prospectName || null,
      propertyName: state.propertyName || propertyName || null,
      terminal: isTerminalState(state),
    });

    if (isTerminalState(state)) {
      if (state.status === "completed") {
        void sendSummaryEmail(callSid);
      }
      res
        .type("text/xml")
        .send(buildSayAndHangupTwiML(buildClosingMessage(state)));
      return;
    }

    res
      .type("text/xml")
      .send(
        buildConnectStreamTwiML(
          callSid,
          state.prospectName || prospectName,
          state.propertyName || propertyName,
        ),
      );
  } catch (error) {
    console.error(error);
    saveState(req.body.CallSid || `error-${Date.now()}`, (current) => ({
      ...current,
      status: "failed",
      lastError: error.message,
    }));
    res
      .type("text/xml")
      .send(
        buildSayAndHangupTwiML(
          "Sorry, I had trouble starting the screening call.",
        ),
      );
  }
});

app.post("/voice/turn", (_req, res) => {
  res
    .status(410)
    .type("text/plain")
    .send("This voice bridge now uses Twilio Media Streams at /voice/stream.");
});

app.get("/voice/state/:callSid", (req, res) => {
  res.json(getState(req.params.callSid));
});

const streamWss = new WebSocketServer({ server, path: "/voice/stream" });

streamWss.on("connection", (ws) => {
  let session = null;

  ws.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Invalid Twilio websocket payload:", error);
      return;
    }

    if (message.event === "connected") {
      console.log("[twilio] stream connected");
      if (session?.callSid) {
        appendRunEvent(session.callSid, "twilio.stream.connected", {
          streamSid: session.streamSid || null,
        });
      }
      return;
    }

    if (message.event === "start") {
      const params = extractTwilioParameters(message);
      const callSid = params.callSid;
      if (!callSid) {
        console.error("[twilio] stream start missing callSid");
        return;
      }

      // logCall not available yet — session created below
      console.log(
        `[call:${callSid.slice(-6)}] << twilio: stream start prospect="${params.prospectName}" property="${params.propertyName}"`,
      );
      appendRunEvent(callSid, "twilio.stream.started", {
        streamSid: message.streamSid || message.start?.streamSid || null,
        prospectName: params.prospectName || null,
        propertyName: params.propertyName || null,
      });

      let state = getState(callSid);
      if (!state) {
        state = await createInterviewSession(
          callSid,
          params.prospectName,
          params.propertyName,
        );
      }

      state = saveState(callSid, (current) => ({
        ...current,
        prospectName: current.prospectName || params.prospectName || "",
        propertyName: current.propertyName || params.propertyName || "",
        streamSid:
          message.streamSid ||
          message.start?.streamSid ||
          current.streamSid ||
          null,
        lastError: null,
      }));

      session = getRealtimeSession(callSid);
      session.twilioSocket = ws;
      session.streamSid = message.streamSid || message.start?.streamSid || null;
      session.prospectName = state.prospectName;
      session.propertyName = state.propertyName;

      logCall(session, "connecting to OpenAI realtime...");
      connectOpenAIRealtime(session);
      return;
    }

    if (!session) {
      return;
    }

    if (message.event === "media") {
      const payload = message.media?.payload;
      if (!payload) {
        return;
      }

      if (
        session.openaiSocket &&
        session.openaiSocket.readyState === WebSocket.OPEN
      ) {
        sendOpenAIJson(session, {
          type: "input_audio_buffer.append",
          audio: payload,
        });
      } else {
        session.pendingTwilioAudio.push(payload);
      }
      return;
    }

    if (message.event === "mark") {
      logCall(session, `<< twilio: mark received (pendingHangup=${session.pendingHangup})`);
      if (session.pendingHangup) {
        scheduleHangup(session.callSid, 250);
      }
      return;
    }

    if (message.event === "stop") {
      logCall(session, `<< twilio: stream stop`);
      appendRunEvent(session.callSid, "twilio.stream.stopped", {
        streamSid: session.streamSid || null,
      });
      closeRealtimeSession(session.callSid, "twilio_stop");
    }
  });

  ws.on("close", () => {
    if (session) {
      closeRealtimeSession(session.callSid, "twilio_close");
    }
  });

  ws.on("error", (error) => {
    console.error("Twilio websocket error:", error);
    if (session) {
      saveState(session.callSid, (current) => ({
        ...current,
        status: "failed",
        lastError: error.message,
      }));
    }
  });
});

function readAllRunEvents() {
  try {
    const raw = fs.readFileSync(eventLogPath, "utf8");
    const events = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // skip malformed line
      }
    }
    return events;
  } catch {
    return [];
  }
}

function groupRunEventsByCall() {
  const events = readAllRunEvents();
  const groups = new Map();
  for (const ev of events) {
    if (!ev || !ev.callSid) continue;
    if (!groups.has(ev.callSid)) groups.set(ev.callSid, []);
    groups.get(ev.callSid).push(ev);
  }
  return groups;
}

function summarizeCall(events) {
  const summary = {
    callSid: null,
    prospectName: null,
    propertyName: null,
    to: null,
    from: null,
    status: null,
    startedAt: null,
    endedAt: null,
    completedAt: null,
    endReason: null,
    summary: null,
    lastError: null,
    messageCount: 0,
  };
  for (const ev of events) {
    if (!summary.callSid && ev.callSid) summary.callSid = ev.callSid;
    if (ev.prospectName && !summary.prospectName) {
      summary.prospectName = ev.prospectName;
    }
    if (ev.propertyName && !summary.propertyName) {
      summary.propertyName = ev.propertyName;
    }
    if (ev.to && !summary.to) summary.to = ev.to;
    if (ev.from && !summary.from) summary.from = ev.from;
    if (!summary.startedAt) summary.startedAt = ev.ts || null;
    if (ev.ts) summary.endedAt = ev.ts;
    if (ev.type === "transcript.user" || ev.type === "transcript.agent") {
      summary.messageCount += 1;
    }
    if (ev.type === "state.update") {
      if (ev.status) summary.status = ev.status;
      if (ev.summary) summary.summary = ev.summary;
      if (ev.endReason) summary.endReason = ev.endReason;
      if (ev.completedAt) summary.completedAt = ev.completedAt;
      if (ev.lastError) summary.lastError = ev.lastError;
    }
  }
  return summary;
}

function buildMcpServer() {
  const mcp = new McpServer({
    name: "voice-agent-transcripts",
    version: "0.1.0",
    instructions:
      "Tools to explore tenant-screening voice calls: list calls, fetch full transcripts, read raw runtime events, and search across transcripts.",
  });

  mcp.registerTool(
    "list_calls",
    {
      description:
        "List recent tenant-screening calls with summary info (prospect, status, start/end, message count). Most recent first.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum number of calls to return. Defaults to 20."),
        status: z
          .string()
          .optional()
          .describe(
            "Filter by latest status (e.g. 'active', 'completed', 'failed').",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO timestamp; only include calls whose startedAt is on or after this.",
          ),
      },
    },
    async ({ limit = 20, status, since }) => {
      const groups = groupRunEventsByCall();
      const calls = [];
      for (const [, events] of groups) calls.push(summarizeCall(events));
      calls.sort((a, b) =>
        (b.startedAt || "").localeCompare(a.startedAt || ""),
      );
      let filtered = calls;
      if (status) filtered = filtered.filter((c) => c.status === status);
      if (since) {
        filtered = filtered.filter(
          (c) => c.startedAt && c.startedAt >= since,
        );
      }
      const result = filtered.slice(0, limit);
      const payload = {
        total: filtered.length,
        returned: result.length,
        calls: result,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  mcp.registerTool(
    "get_call_transcript",
    {
      description:
        "Return the full turn-by-turn transcript plus the final summary for a specific call.",
      inputSchema: {
        callSid: z.string().describe("Twilio Call SID, e.g. CAxxxx..."),
      },
    },
    async ({ callSid }) => {
      const groups = groupRunEventsByCall();
      const events = groups.get(callSid);
      if (!events) {
        const payload = { callSid, found: false };
        return {
          content: [
            {
              type: "text",
              text: `No events found for callSid ${callSid}.`,
            },
          ],
          structuredContent: payload,
        };
      }
      const transcript = [];
      for (const ev of events) {
        if (ev.type === "transcript.user" || ev.type === "transcript.agent") {
          transcript.push({
            ts: ev.ts,
            role: ev.type === "transcript.user" ? "caller" : "agent",
            text: ev.text,
            goal: ev.currentGoalKey || null,
          });
        }
      }
      const payload = {
        callSid,
        found: true,
        summary: summarizeCall(events),
        transcript,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  mcp.registerTool(
    "get_call_events",
    {
      description:
        "Return raw runtime events for a call, optionally filtered by event type.",
      inputSchema: {
        callSid: z.string().describe("Twilio Call SID."),
        types: z
          .array(z.string())
          .optional()
          .describe(
            "If provided, only events whose 'type' matches one of these are returned (e.g. 'state.update', 'transcript.user').",
          ),
      },
    },
    async ({ callSid, types }) => {
      const groups = groupRunEventsByCall();
      const events = groups.get(callSid) || [];
      const filtered =
        types && types.length
          ? events.filter((e) => types.includes(e.type))
          : events;
      const payload = {
        callSid,
        count: filtered.length,
        events: filtered,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  mcp.registerTool(
    "search_transcripts",
    {
      description:
        "Case-insensitive substring search across every transcript turn. Returns matching turns with callSid, timestamp, role, goal, and surrounding context.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Text to search for within transcript turns."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum matches to return. Defaults to 50."),
        role: z
          .enum(["caller", "agent"])
          .optional()
          .describe("Restrict to caller or agent turns."),
      },
    },
    async ({ query, limit = 50, role }) => {
      const events = readAllRunEvents();
      const needle = query.toLowerCase();
      const matches = [];
      for (const ev of events) {
        if (
          ev.type !== "transcript.user" &&
          ev.type !== "transcript.agent"
        ) {
          continue;
        }
        const evRole = ev.type === "transcript.user" ? "caller" : "agent";
        if (role && role !== evRole) continue;
        if (typeof ev.text !== "string") continue;
        if (!ev.text.toLowerCase().includes(needle)) continue;
        matches.push({
          callSid: ev.callSid,
          ts: ev.ts,
          role: evRole,
          text: ev.text,
          goal: ev.currentGoalKey || null,
        });
        if (matches.length >= limit) break;
      }
      const payload = {
        query,
        role: role || null,
        count: matches.length,
        matches,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  return mcp;
}

const mcpOAuthSecret = (process.env.MCP_BEARER_TOKEN || "").trim();
const mcpIssuerUrl = appBaseUrl;
const mcpStorePath =
  process.env.MCP_OAUTH_STORE_PATH ||
  path.join(path.dirname(statePath), "mcp-oauth-store.json");

if (mcpOAuthSecret && mcpIssuerUrl) {
  const { requireAuth } = mountMcpOAuth(app, {
    storePath: mcpStorePath,
    consentSecret: mcpOAuthSecret,
    issuerUrl: mcpIssuerUrl,
  });

  app.post("/mcp", requireAuth, async (req, res) => {
    let transport;
    let mcp;
    try {
      mcp = buildMcpServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        try {
          transport?.close();
        } catch {}
        try {
          mcp?.close();
        } catch {}
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[mcp] handler error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  console.log(
    `[mcp] OAuth-protected endpoint mounted at ${mcpIssuerUrl}/mcp (issuer ${mcpIssuerUrl})`,
  );
} else {
  console.warn(
    "[mcp] /mcp endpoint NOT mounted: requires both MCP_BEARER_TOKEN and APP_BASE_URL.",
  );
}

const port = Number(process.env.VOICE_PORT || 8002);
server.listen(port, () => {
  console.log(`Voice bridge listening on port ${port}`);
  console.log(
    `Realtime model: ${openaiRealtimeModel} using ${openaiRealtimeVoice}`,
  );
});
