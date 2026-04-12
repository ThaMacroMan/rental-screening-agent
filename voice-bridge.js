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
requiredEnv('TWILIO_ACCOUNT_SID');

if (!agentId) {
  throw new Error('Missing required environment variable: VOICE_AGENT_ID or AGENT_ID');
}

const runtimePath = process.env.VOICE_RUNTIME_PATH || path.join(__dirname, '.runtime', 'runtime.json');
const statePath = process.env.VOICE_STATE_PATH || path.join(__dirname, '.runtime', 'tenant-screening-state.json');
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
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
  const externalBaseUrl = publicBaseUrl || `${req.protocol}://${req.get('host')}`;
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
    publicBaseUrl: runtime?.publicBaseUrl || null,
    statePath,
  });
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
