#!/usr/bin/env node

const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const anthropicApiKey = requiredEnv('ANTHROPIC_API_KEY');
const agentId = process.env.VOICE_AGENT_ID || process.env.AGENT_ID;
const environmentId = requiredEnv('ENVIRONMENT_ID');
const twilioAuthToken = requiredEnv('TWILIO_AUTH_TOKEN');
const twilioAccountSid = requiredEnv('TWILIO_ACCOUNT_SID');
const twilioFromNumber = requiredEnv('TWILIO_FROM_NUMBER');

if (!agentId) {
  throw new Error('Missing required environment variable: VOICE_AGENT_ID or AGENT_ID');
}

const runtimePath = process.env.VOICE_RUNTIME_PATH || path.join(__dirname, '.runtime', 'runtime.json');
const statePath = process.env.VOICE_STATE_PATH || path.join(__dirname, '.runtime', 'tenant-screening-state.json');
const appBaseUrl = (process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
// Voice options for quick switching:
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna-Generative';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Google.en-US-Chirp3-HD-Aoede';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna-Neural';
// const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna';
const defaultVoice = process.env.TWILIO_TTS_VOICE || 'Polly.Joanna-Generative';
const fallbackVoice = process.env.TWILIO_TTS_VOICE_FALLBACK || 'Polly.Joanna-Neural';
const selectedVoice = process.env.TWILIO_TTS_USE_FALLBACK === 'true' ? fallbackVoice : defaultVoice;
const selectedLanguage = process.env.TWILIO_TTS_LANGUAGE || 'en-US';
console.log(`[voice-bridge] Twilio TTS voice: ${selectedVoice} (fallback: ${fallbackVoice}, language: ${selectedLanguage})`);
const summaryEmailTo = process.env.SUMMARY_EMAIL_TO || 'joshkuski@gmail.com';
const summaryEmailFrom = process.env.SUMMARY_EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'tenant-screening@localhost';
const smtpUrl = process.env.SMTP_URL || '';
const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const smtpSecure = process.env.SMTP_SECURE === 'true';
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const twilioClient = twilio(twilioAccountSid, twilioAuthToken);

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
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
  return String(value || '').trim();
}

function loadRuntimeConfig() {
  const runtime = readJsonFile(runtimePath, null);
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  return runtime;
}

function loadStateStore() {
  const fallback = { version: 1, updatedAt: null, calls: {} };
  const stored = readJsonFile(statePath, fallback);

  if (!stored || typeof stored !== 'object') {
    return fallback;
  }

  if (stored.calls && typeof stored.calls === 'object' && !Array.isArray(stored.calls)) {
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

function buildGatherTwiML(prompt, nextPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech dtmf" action="${xmlEscape(nextPath)}" method="POST" timeout="8" speechTimeout="auto" actionOnEmptyResult="true">
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
  const name = state?.prospectName || 'there';
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
    newline: 'unix',
    path: '/usr/sbin/sendmail',
  });
}

function getRuntimeBaseUrl() {
  const runtime = loadRuntimeConfig();
  return runtime?.appBaseUrl || runtime?.publicBaseUrl || process.env.VOICE_PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
}

function resolveScreeningUrl(args) {
  const screeningUrl = normalizeText(args.screeningUrl);
  if (screeningUrl) {
    return new URL(screeningUrl);
  }

  const baseUrl = getRuntimeBaseUrl();
  if (!baseUrl) {
    throw new Error('Provide screeningUrl or start the launcher first so the live voice URL is available.');
  }

  return new URL('/voice/start', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
}

function parseBooleanField(value) {
  if (value === true || value === 'true' || value === 'on' || value === '1') {
    return true;
  }

  if (value === false || value === 'false' || value === 'off' || value === '0' || value === '' || value == null) {
    return false;
  }

  return Boolean(value);
}

function parseIntegerField(value, fieldName, { min, max } = {}) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} must be an integer.`);
  }

  if (typeof min === 'number' && parsed < min) {
    throw new Error(`${fieldName} must be at least ${min}.`);
  }

  if (typeof max === 'number' && parsed > max) {
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
    throw new Error('Destination phone number is required.');
  }

  if (!from) {
    throw new Error('No caller ID available. Set TWILIO_FROM_NUMBER or pass from explicitly.');
  }

  const params = {
    to,
    from,
    record: parseBooleanField(args.record),
  };

  if (normalizeText(args.screeningUrl) || getRuntimeBaseUrl()) {
    const screeningUrl = resolveScreeningUrl(args);
    if (prospectName) {
      screeningUrl.searchParams.set('prospectName', prospectName);
    }
    if (propertyName) {
      screeningUrl.searchParams.set('propertyName', propertyName);
    }
    params.url = screeningUrl.toString();
  } else if (screeningTwiml) {
    params.twiml = screeningTwiml;
  } else {
    throw new Error('Provide screeningUrl or screeningTwiml.');
  }

  const statusCallback = normalizeText(args.statusCallback);
  if (statusCallback) {
    params.statusCallback = statusCallback;
    params.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
  }

  const timeout = parseIntegerField(args.timeout, 'timeout', { min: 5, max: 600 });
  if (timeout !== null) {
    params.timeout = timeout;
  }

  const machineDetection = normalizeText(args.machineDetection);
  if (machineDetection) {
    params.machineDetection = machineDetection;
  }

  return params;
}

function renderTestingPage() {
  const runtime = loadRuntimeConfig();
  const baseUrl = getRuntimeBaseUrl();
  const defaultScreeningUrl = runtime?.voiceStartUrl || (baseUrl ? `${baseUrl}/voice/start` : '');
  const configuredFromNumber = defaultFromNumber || '';
  const context = {
    baseUrl: baseUrl || null,
    voiceStartUrl: runtime?.voiceStartUrl || null,
    defaultScreeningUrl: defaultScreeningUrl || null,
    defaultFromNumber: configuredFromNumber || null,
    statePath,
  };

  const contextJson = JSON.stringify(context).replace(/</g, '\\u003c');

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
  lines.push(`Tenant screening summary for ${state.prospectName || 'unknown prospect'}`);
  lines.push(`Property: ${state.propertyName || 'unknown property'}`);
  lines.push(`Call SID: ${state.callSid}`);
  lines.push('');
  lines.push(state.summary || state.lastAgentMessage || 'No summary available.');
  lines.push('');
  lines.push('Answers:');
  for (const answer of answers) {
    lines.push(`${answer.questionNumber}. ${answer.answer}`);
  }
  return lines.join('\n');
}

async function sendSummaryEmail(callSid) {
  const state = getState(callSid);
  if (!state || state.status !== 'completed') {
    return;
  }

  const transport = createMailTransport();
  if (!transport) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: 'skipped_no_transport',
      emailTo: summaryEmailTo,
      emailError: null,
    }));
    return;
  }

  if (!summaryEmailFrom) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: 'failed',
      emailTo: summaryEmailTo,
      emailError: 'Missing SUMMARY_EMAIL_FROM or SMTP_FROM/SMTP_USER',
    }));
    return;
  }

  try {
    const info = await transport.sendMail({
      from: summaryEmailFrom,
      to: summaryEmailTo,
      subject: `Tenant screening summary: ${state.prospectName || 'Unknown prospect'}`,
      text: buildEmailText(state),
    });

    saveState(callSid, (current) => ({
      ...current,
      emailStatus: 'sent',
      emailTo: summaryEmailTo,
      emailMessageId: info.messageId || null,
      emailSentAt: new Date().toISOString(),
      emailError: null,
    }));
  } catch (error) {
    saveState(callSid, (current) => ({
      ...current,
      emailStatus: 'failed',
      emailTo: summaryEmailTo,
      emailError: error.message,
    }));
    console.error('Failed to send screening summary email:', error);
  }
}

async function anthropicJson(apiPath, body) {
  const response = await fetch(`https://api.anthropic.com/v1${apiPath}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      'content-type': 'application/json',
      accept: 'application/json',
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
  const session = await anthropicJson('/sessions', {
    agent: agentId,
    environment_id: environmentId,
    title: `Tenant screening ${callSid}`,
    metadata: {
      call_sid: callSid,
      prospect_name: prospectName || '',
      property_name: propertyName || '',
    },
  });

  const now = new Date().toISOString();
  const state = {
    callSid,
    sessionId: session.id,
    prospectName: normalizeText(prospectName),
    propertyName: normalizeText(propertyName),
    turn: 0,
    answers: [],
    summary: '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastPrompt: '',
    lastAgentMessage: '',
    lastUserMessage: '',
    lastError: null,
  };

  callState.set(callSid, state);
  persistStateStore();
  return state;
}

function buildTurnPrompt(state, callerText) {
  const promptLines = [
    'You are conducting a live tenant screening phone interview.',
    'Return plain text only. No markdown, no bullets, and no preamble.',
    'Speak naturally and keep each question short.',
    'Ask exactly one question at a time.',
    'Do not ask about protected characteristics.',
    `Prospect name: ${state.prospectName || 'unknown'}.`,
    `Property: ${state.propertyName || 'unknown'}.`,
  ];

  if (state.turn === 0) {
    promptLines.push('Ask the first screening question now about employment and income verification.');
  } else if (state.turn === 1) {
    promptLines.push(`The caller answered the first question: ${callerText || 'no answer captured'}.`);
    promptLines.push('Ask the second screening question now about move-in timeline and desired lease term.');
  } else if (state.turn === 2) {
    promptLines.push(`The caller answered the second question: ${callerText || 'no answer captured'}.`);
    promptLines.push('Ask the third screening question now about rental history and references.');
  } else {
    promptLines.push('The caller has answered all three screening questions.');
    promptLines.push(`Collected answers: ${JSON.stringify(state.answers, null, 2)}.`);
    promptLines.push('Provide a concise reviewer summary for the human reviewer only. Do not include a farewell and do not speak as if addressing the caller.');
  }

  return promptLines.join(' ');
}

async function sendSessionMessage(sessionId, text) {
  await anthropicJson(`/sessions/${sessionId}/events`, {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text }],
      },
    ],
  });
}

async function listSessionEvents(sessionId) {
  const response = await fetch(`https://api.anthropic.com/v1/sessions/${sessionId}/events?beta=true`, {
    headers: {
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'managed-agents-2026-04-01',
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic events API ${response.status}: ${text}`);
  }

  const payload = await response.json();
  return payload.data || [];
}

async function waitForAgentReply(sessionId, previousCount) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const events = await listSessionEvents(sessionId);
    const agentMessages = events.filter((event) => event.type === 'agent.message');
    if (agentMessages.length > previousCount) {
      return agentMessages[agentMessages.length - 1];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for agent reply');
}

function extractTextFromAgentMessage(messageEvent) {
  const content = messageEvent?.content || [];
  return content
    .map((block) => (block && block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function validateTwilioRequest(req) {
  if (process.env.VALIDATE_TWILIO_WEBHOOKS !== 'true') {
    return true;
  }

  const signature = req.get('X-Twilio-Signature') || '';
  const externalBaseUrl = appBaseUrl || `${req.protocol}://${req.get('host')}`;
  const url = `${externalBaseUrl}${req.originalUrl}`;
  return twilio.validateRequest(twilioAuthToken, signature, url, req.body);
}

function parseRequestText(req) {
  return normalizeText(req.body.SpeechResult || req.body.Digits || '');
}

function getProspectAndProperty(req) {
  return {
    prospectName: normalizeText(req.query.prospectName || req.body.prospectName || ''),
    propertyName: normalizeText(req.query.propertyName || req.body.propertyName || ''),
  };
}

async function advanceInterview(callSid, callerText, prospectName, propertyName) {
  let state = getState(callSid);
  if (!state) {
    state = await createInterviewSession(callSid, prospectName, propertyName);
  }

  const userText = normalizeText(callerText);

  if (userText) {
    state = saveState(callSid, (current) => {
      const nextAnswers = Array.isArray(current.answers) ? [...current.answers] : [];
      if (current.turn >= 1 && current.turn <= 3) {
        nextAnswers.push({
          questionNumber: current.turn,
          answer: userText,
          receivedAt: new Date().toISOString(),
        });
      }

      return {
        ...current,
        lastUserMessage: userText,
        answers: nextAnswers,
      };
    });
  }

  if (state.status === 'completed') {
    return state.lastAgentMessage || state.summary || 'Thank you. Goodbye.';
  }

  const prompt = buildTurnPrompt(state, userText);
  const priorAgentMessages = (await listSessionEvents(state.sessionId)).filter((event) => event.type === 'agent.message').length;
  await sendSessionMessage(state.sessionId, prompt);
  const reply = await waitForAgentReply(state.sessionId, priorAgentMessages);
  const replyText = extractTextFromAgentMessage(reply) || 'Thank you. Goodbye.';

  const nextState = saveState(callSid, (current) => {
    const nextTurn = (current.turn || 0) + 1;
    const completed = nextTurn >= 4;
    return {
      ...current,
      turn: nextTurn,
      lastPrompt: prompt,
      lastAgentMessage: replyText,
      summary: completed ? replyText : current.summary || '',
      status: completed ? 'completed' : 'active',
      completedAt: completed ? new Date().toISOString() : current.completedAt || null,
      emailStatus: completed ? 'pending' : current.emailStatus || null,
      lastError: null,
    };
  });

  if (nextState.status === 'completed') {
    void sendSummaryEmail(callSid);
  }

  return nextState.lastAgentMessage || replyText;
}

app.get('/health', (_req, res) => {
  const runtime = loadRuntimeConfig();
  res.json({
    ok: true,
    voice: selectedVoice,
    fallbackVoice,
    publicBaseUrl: runtime?.appBaseUrl || runtime?.publicBaseUrl || null,
    statePath,
  });
});

app.get('/testing', (_req, res) => {
  res.type('html').send(renderTestingPage());
});

app.post('/testing/start', async (req, res) => {
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
    console.error('Failed to start testing call:', error);
    res.status(400).json({ error: error.message || 'Failed to start the call.' });
  }
});

app.post('/voice/start', async (req, res) => {
  if (!validateTwilioRequest(req)) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }

  try {
    const callSid = req.body.CallSid;
    if (!callSid) {
      res.status(400).type('text/plain').send('Missing CallSid');
      return;
    }

    const { prospectName, propertyName } = getProspectAndProperty(req);
    let state = getState(callSid);

    if (!state) {
      state = await createInterviewSession(callSid, prospectName, propertyName);
    }

    if (state.status === 'completed') {
      void sendSummaryEmail(callSid);
      res.type('text/xml').send(buildSayAndHangupTwiML(buildClosingMessage(state)));
      return;
    }

    if (state.lastAgentMessage && state.turn > 0) {
      res.type('text/xml').send(buildGatherTwiML(state.lastAgentMessage, '/voice/turn'));
      return;
    }

    const prompt = await advanceInterview(callSid, '', state.prospectName, state.propertyName);
    res.type('text/xml').send(buildGatherTwiML(prompt, '/voice/turn'));
  } catch (error) {
    console.error(error);
    saveState(req.body.CallSid || `error-${Date.now()}`, (current) => ({
      ...current,
      status: 'failed',
      lastError: error.message,
    }));
    res.type('text/xml').send(buildSayAndHangupTwiML('Sorry, I had trouble starting the screening call.'));
  }
});

app.post('/voice/turn', async (req, res) => {
  if (!validateTwilioRequest(req)) {
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }

  try {
    const callSid = req.body.CallSid;
    if (!callSid) {
      res.status(400).type('text/plain').send('Missing CallSid');
      return;
    }

    const callerText = parseRequestText(req);
    const { prospectName, propertyName } = getProspectAndProperty(req);
    let state = getState(callSid);

    if (!state) {
      state = await createInterviewSession(callSid, prospectName, propertyName);
    }

    if (state.status === 'completed') {
      void sendSummaryEmail(callSid);
      res.type('text/xml').send(buildSayAndHangupTwiML(buildClosingMessage(state)));
      return;
    }

    if (!callerText) {
      const reprompt = state.lastAgentMessage || 'Sorry, I did not catch that. Please answer again.';
      res.type('text/xml').send(buildGatherTwiML(reprompt, '/voice/turn'));
      return;
    }

    const prompt = await advanceInterview(callSid, callerText, state.prospectName, state.propertyName);
    const latestState = getState(callSid);

    if (latestState?.status === 'completed') {
      res.type('text/xml').send(buildSayAndHangupTwiML(buildClosingMessage(latestState)));
      return;
    }

    res.type('text/xml').send(buildGatherTwiML(prompt, '/voice/turn'));
  } catch (error) {
    console.error(error);
    if (req.body?.CallSid) {
      saveState(req.body.CallSid, (current) => ({
        ...current,
        status: 'failed',
        lastError: error.message,
      }));
    }
    res.type('text/xml').send(buildSayAndHangupTwiML('Sorry, I had trouble processing that answer.'));
  }
});

app.get('/voice/state/:callSid', (req, res) => {
  res.json(getState(req.params.callSid));
});

const port = Number(process.env.VOICE_PORT || 8002);
app.listen(port, () => {
  console.log(`Voice bridge listening on port ${port}`);
  console.log(`Voice prompts use ${selectedVoice} (${selectedLanguage})`);
});
