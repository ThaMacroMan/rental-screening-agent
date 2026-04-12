#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod/v4");
const twilio = require("twilio");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
const apiKeySid = requiredEnv("SID");
const apiKeySecret = requiredEnv("SECRET");
const defaultFromNumber = process.env.TWILIO_FROM_NUMBER || "";
const runtimePath = process.env.VOICE_RUNTIME_PATH || path.join(__dirname, ".runtime", "runtime.json");

const client = twilio(apiKeySid, apiKeySecret, { accountSid });

function readRuntimeConfig() {
  try {
    const raw = fs.readFileSync(runtimePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveScreeningUrl(args) {
  if (args.screeningUrl) {
    return new URL(args.screeningUrl);
  }

  const runtime = readRuntimeConfig();
  const baseUrl = runtime?.publicBaseUrl || process.env.VOICE_PUBLIC_BASE_URL;
  if (!baseUrl) {
    throw new Error("Provide screeningUrl or start the launcher first so the live voice URL is available.");
  }

  return new URL("/voice/start", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function buildStartCallParams(args) {
  const params = {
    to: args.to,
    from: args.from || defaultFromNumber,
    record: args.record ?? false,
  };

  if (!params.from) {
    throw new Error("No caller ID available. Set TWILIO_FROM_NUMBER or pass from explicitly.");
  }

  if (args.screeningUrl || readRuntimeConfig() || process.env.VOICE_PUBLIC_BASE_URL) {
    const screeningUrl = resolveScreeningUrl(args);
    if (args.prospectName) {
      screeningUrl.searchParams.set("prospectName", args.prospectName);
    }
    if (args.propertyName) {
      screeningUrl.searchParams.set("propertyName", args.propertyName);
    }
    params.url = screeningUrl.toString();
  } else if (args.screeningTwiml) {
    params.twiml = args.screeningTwiml;
  } else {
    throw new Error("Provide screeningUrl or screeningTwiml.");
  }

  if (args.statusCallback) {
    params.statusCallback = args.statusCallback;
    params.statusCallbackEvent = ["initiated", "ringing", "answered", "completed"];
  }

  if (args.timeout) {
    params.timeout = args.timeout;
  }

  if (args.machineDetection) {
    params.machineDetection = args.machineDetection;
  }

  return params;
}

const server = new McpServer({
  name: "tenant-screening-twilio",
  version: "0.1.0",
  instructions:
    "Use these tools for tenant screening voice calls only. Prefer start_tenant_screening_call to begin a call, then get_call_status to monitor it, and end_call only when you need to terminate an active call.",
});

server.registerTool(
  "start_tenant_screening_call",
  {
    description:
      "Start one outbound tenant-screening phone call through Twilio. Use screeningUrl when you already have a TwiML or voice webhook endpoint. Use screeningTwiml only for short inline TwiML.",
    inputSchema: {
      to: z.string().describe("Prospect phone number in E.164 format, for example +15551234567."),
      from: z
        .string()
        .optional()
        .describe("Optional Twilio caller ID in E.164 format. Defaults to TWILIO_FROM_NUMBER."),
      prospectName: z.string().optional().describe("Prospect name for your own bookkeeping."),
      propertyName: z.string().optional().describe("Property or apartment complex name."),
      screeningUrl: z
        .string()
        .url()
        .optional()
        .describe("Voice webhook or TwiML Bin URL Twilio should request when the call connects."),
      screeningTwiml: z
        .string()
        .optional()
        .describe("Inline TwiML to execute when the call connects. Use only for short payloads."),
      statusCallback: z
        .string()
        .url()
        .optional()
        .describe("Optional webhook URL for call progress updates."),
      record: z.boolean().optional().describe("Whether to record the call. Defaults to false."),
      timeout: z
        .number()
        .int()
        .min(5)
        .max(600)
        .optional()
        .describe("Ring timeout in seconds."),
      machineDetection: z
        .enum(["Enable", "DetectMessageEnd"])
        .optional()
        .describe("Optional answering machine detection mode."),
    },
    outputSchema: {
      callSid: z.string(),
      accountSid: z.string(),
      to: z.string(),
      from: z.string(),
      status: z.string(),
      direction: z.string().nullable(),
      prospectName: z.string().nullable(),
      propertyName: z.string().nullable(),
      screeningUrl: z.string().nullable(),
    },
  },
  async (args) => {
    const callParams = buildStartCallParams(args);
    const call = await client.calls.create(callParams);
    const structuredContent = {
      callSid: call.sid,
      accountSid: call.accountSid,
      to: call.to,
      from: call.from,
      status: call.status,
      direction: call.direction ?? null,
      prospectName: args.prospectName ?? null,
      propertyName: args.propertyName ?? null,
      screeningUrl: callParams.url ?? null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

server.registerTool(
  "get_call_status",
  {
    description: "Fetch the latest status and summary fields for a Twilio call.",
    inputSchema: {
      callSid: z.string().describe("Twilio Call SID, for example CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx."),
    },
    outputSchema: {
      callSid: z.string(),
      status: z.string(),
      to: z.string().nullable(),
      from: z.string().nullable(),
      direction: z.string().nullable(),
      duration: z.string().nullable(),
      answeredBy: z.string().nullable(),
      startTime: z.string().nullable(),
      endTime: z.string().nullable(),
    },
  },
  async ({ callSid }) => {
    const call = await client.calls(callSid).fetch();
    const structuredContent = {
      callSid: call.sid,
      status: call.status,
      to: call.to ?? null,
      from: call.from ?? null,
      direction: call.direction ?? null,
      duration: call.duration ?? null,
      answeredBy: call.answeredBy ?? null,
      startTime: call.startTime ? call.startTime.toISOString() : null,
      endTime: call.endTime ? call.endTime.toISOString() : null,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

server.registerTool(
  "end_call",
  {
    description: "End an in-progress Twilio call immediately.",
    inputSchema: {
      callSid: z.string().describe("Twilio Call SID to terminate."),
    },
    outputSchema: {
      callSid: z.string(),
      status: z.string(),
    },
  },
  async ({ callSid }) => {
    const call = await client.calls(callSid).update({ status: "completed" });
    const structuredContent = {
      callSid: call.sid,
      status: call.status,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tenant screening MCP server running on stdio");
}

main().catch((error) => {
  console.error("Tenant screening MCP server failed:", error);
  process.exit(1);
});
