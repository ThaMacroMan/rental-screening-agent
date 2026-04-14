#!/usr/bin/env node

const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

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
const openaiRealtimeVoice = normalizeText(
  process.env.OPENAI_REALTIME_VOICE || "marin",
);
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
  2000,
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
  {
    type: "function",
    name: "escalate_to_human",
    description:
      "Hand the call off to a human when the caller is unclear or the flow cannot continue.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: {
          type: "string",
        },
        summary: {
          type: "string",
        },
      },
      required: ["reason", "summary"],
    },
  },
];

const runtimePath =
  process.env.VOICE_RUNTIME_PATH ||
  path.join(__dirname, ".runtime", "runtime.json");
const statePath =
  process.env.VOICE_STATE_PATH ||
  path.join(__dirname, ".runtime", "tenant-screening-state.json");
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
  return next;
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
  return `Thank you, ${name}. Someone from our team will follow up soon. Goodbye.`;
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
  const defaultScreeningUrl =
    runtime?.voiceStartUrl || (baseUrl ? `${baseUrl}/voice/start` : "");
  const configuredFromNumber = defaultFromNumber || "";
  const context = {
    baseUrl: baseUrl || null,
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

        <section class="panel">
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
    "Keep the conversation warm, concise, and natural.",
    "Wait for the caller to speak first before you say anything.",
    "When the caller first says hello or starts speaking, briefly greet them and then begin the screening.",
    "Ask exactly one question at a time.",
    "The caller audio may be imperfect, so if an answer seems partial or noisy, ask one short clarification instead of moving on.",
    "Do not ask about protected characteristics.",
    "Use the tools when you have enough information to record a screening update, finish the screening, or escalate to a human.",
    "When the current goal is answered well enough, call record_screening_update before continuing.",
    "When all goals are complete, call finish_screening.",
    "When the caller is not understandable after a couple of attempts or refuses to continue, call escalate_to_human.",
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
  let output;

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
    state = escalateToHuman(callSid, args);
    logCall(session, `tool: escalate_to_human reason="${args.reason}"`);
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
      if (session.responseDebounceTimer) {
        clearTimeout(session.responseDebounceTimer);
        session.responseDebounceTimer = null;
        logCall(session, "   cancelled pending response (user still talking)");
      }
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
      break;
    case "input_audio_buffer.committed":
      logCall(session, "<< openai: audio_buffer.committed");
      // Don't respond immediately — debounce to let the user finish their thought.
      // If they start speaking again within the delay, the timer is cancelled above.
      if (session.responseDebounceTimer) {
        clearTimeout(session.responseDebounceTimer);
      }
      session.responseDebounceTimer = setTimeout(() => {
        session.responseDebounceTimer = null;
        if (!session.closed && !session.responseInProgress) {
          logCall(session, "   debounce fired — sending response.create");
          sendOpenAIJson(session, { type: "response.create" });
          session.responseInProgress = true;
        }
      }, openaiRealtimeResponseDelayMs);
      break;
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = (payload.transcript || "").trim();
      logCall(session, `<< openai: user transcript: "${transcript}"`);
      if (transcript.length <= 2) {
        logCall(session, "   empty/noise transcript — cancelling response + clearing twilio buffer");
        if (session.responseInProgress) {
          sendOpenAIJson(session, { type: "response.cancel" });
        }
        // Clear audio already queued in Twilio so the user doesn't hear
        // a partial "I didn't catch that" from the noise-triggered response
        sendTwilioJson(session, { event: "clear", streamSid: session.streamSid });
        session.assistantSpeaking = false;
        break;
      }
      // If the transcript looks incomplete (filler words, trailing off)
      // and we have a debounce timer pending, extend it to give the user
      // more time to finish their thought.
      if (looksIncomplete(transcript) && session.responseDebounceTimer) {
        clearTimeout(session.responseDebounceTimer);
        const extendedDelay = openaiRealtimeResponseDelayMs * 2;
        logCall(session, `   incomplete transcript detected — extending debounce to ${extendedDelay}ms`);
        session.responseDebounceTimer = setTimeout(() => {
          session.responseDebounceTimer = null;
          if (!session.closed && !session.responseInProgress) {
            logCall(session, "   extended debounce fired — sending response.create");
            sendOpenAIJson(session, { type: "response.create" });
            session.responseInProgress = true;
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

      // After a tool-call-only response, OpenAI won't auto-generate a
      // follow-up. We need to explicitly request one so the agent speaks
      // the next question instead of sitting in silence.
      const hasOnlyToolCalls =
        outputs.length > 0 && outputs.every((o) => o.type === "function_call");
      if (hasOnlyToolCalls && !session.closed) {
        logCall(session, `   tool-call-only response — sending response.create for follow-up`);
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
  };

  callState.set(callSid, state);
  persistStateStore();
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
    "Be conversational and warm, not robotic.",
    "Ask exactly one question at a time.",
    "Keep spoken questions short and natural for phone audio.",
    "Do not ask about protected characteristics.",
    "If the transcript is partial but useful, capture what you can and ask a focused follow-up.",
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

app.get("/testing", (_req, res) => {
  res.type("html").send(renderTestingPage());
});

app.post("/testing/start", async (req, res) => {
  try {
    const callParams = buildOutboundCallParams(req.body || {});
    const call = await twilioClient.calls.create(callParams);
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

      logCall(session, `<< twilio: stream start prospect="${params.prospectName}" property="${params.propertyName}"`);
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

const port = Number(process.env.VOICE_PORT || 8002);
server.listen(port, () => {
  console.log(`Voice bridge listening on port ${port}`);
  console.log(
    `Realtime model: ${openaiRealtimeModel} using ${openaiRealtimeVoice}`,
  );
});
