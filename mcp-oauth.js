const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const {
  mcpAuthRouter,
} = require("@modelcontextprotocol/sdk/server/auth/router.js");
const {
  requireBearerAuth,
} = require("@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js");

function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class OAuthStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._mem = null;
  }

  _ensureLoaded() {
    if (this._mem) return;
    try {
      this._mem = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this._mem = {};
    }
    this._mem.clients ||= {};
    this._mem.codes ||= {};
    this._mem.access ||= {};
    this._mem.refresh ||= {};
  }

  _flush() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._mem, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getClient(id) {
    this._ensureLoaded();
    return this._mem.clients[id];
  }

  putClient(client) {
    this._ensureLoaded();
    this._mem.clients[client.client_id] = client;
    this._flush();
  }

  putCode(code, data) {
    this._ensureLoaded();
    this._mem.codes[code] = data;
    this._flush();
  }

  peekCode(code) {
    this._ensureLoaded();
    const entry = this._mem.codes[code];
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      delete this._mem.codes[code];
      this._flush();
      return null;
    }
    return entry;
  }

  takeCode(code) {
    const entry = this.peekCode(code);
    if (!entry) return null;
    delete this._mem.codes[code];
    this._flush();
    return entry;
  }

  putAccess(token, data) {
    this._ensureLoaded();
    this._mem.access[token] = data;
    this._flush();
  }

  getAccess(token) {
    this._ensureLoaded();
    const entry = this._mem.access[token];
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      delete this._mem.access[token];
      this._flush();
      return null;
    }
    return entry;
  }

  putRefresh(token, data) {
    this._ensureLoaded();
    this._mem.refresh[token] = data;
    this._flush();
  }

  takeRefresh(token) {
    this._ensureLoaded();
    const entry = this._mem.refresh[token];
    if (!entry) return null;
    delete this._mem.refresh[token];
    this._flush();
    return entry;
  }
}

function renderConsentForm({ client, params, error }) {
  const paramsB64 = Buffer.from(JSON.stringify(params)).toString("base64");
  const errorHtml = error
    ? `<p style="color:#ff6b6b;margin:8px 0 0;">${htmlEscape(error)}</p>`
    : "";
  const clientName = htmlEscape(client.client_name || client.client_id);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approve ${clientName}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1017; color: #eef0f4; max-width: 460px; margin: 80px auto; padding: 0 24px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { line-height: 1.5; color: #aab1bd; margin: 8px 0 16px; }
    label { display: block; font-size: 13px; color: #aab1bd; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; box-sizing: border-box; background: #161a23; border: 1px solid #2a2f3d; border-radius: 8px; color: #eef0f4; font-size: 14px; }
    button { width: 100%; padding: 12px 14px; margin-top: 16px; background: #4a7cff; color: white; border: 0; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; }
    code { background: #161a23; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Approve <strong>${clientName}</strong>?</h1>
  <p>This client is asking to access your Voice Agent transcripts via MCP. Enter your consent token (the value of <code>MCP_BEARER_TOKEN</code>) to approve.</p>
  <form method="post" action="/oauth/approve">
    <label for="consent_token">Consent token</label>
    <input type="password" id="consent_token" name="consent_token" autofocus required autocomplete="off" />
    ${errorHtml}
    <input type="hidden" name="params" value="${paramsB64}" />
    <input type="hidden" name="client_id" value="${htmlEscape(client.client_id)}" />
    <button type="submit">Approve access</button>
  </form>
</body>
</html>`;
}

class FileOAuthProvider {
  constructor({ store, accessTokenTtlSec = 3600, codeTtlSec = 600 }) {
    this.store = store;
    this.accessTokenTtlSec = accessTokenTtlSec;
    this.codeTtlSec = codeTtlSec;
    this._clientsStore = {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => {
        const client_id = `mcp_${crypto.randomBytes(12).toString("hex")}`;
        const issued = Math.floor(Date.now() / 1000);
        const full = {
          ...client,
          client_id,
          client_id_issued_at: issued,
        };
        this.store.putClient(full);
        return full;
      },
    };
  }

  get clientsStore() {
    return this._clientsStore;
  }

  async authorize(client, params, res) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(renderConsentForm({ client, params }));
  }

  async challengeForAuthorizationCode(client, code) {
    const entry = this.store.peekCode(code);
    if (!entry || entry.client_id !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    return entry.code_challenge;
  }

  async exchangeAuthorizationCode(
    client,
    code,
    _codeVerifier,
    redirectUri,
    _resource,
  ) {
    const entry = this.store.takeCode(code);
    if (!entry || entry.client_id !== client.client_id) {
      throw new Error("Invalid authorization code");
    }
    if (redirectUri && entry.redirect_uri !== redirectUri) {
      throw new Error("redirect_uri mismatch");
    }
    return this._issueTokens(client);
  }

  async exchangeRefreshToken(client, refreshToken, _scopes, _resource) {
    const entry = this.store.takeRefresh(refreshToken);
    if (!entry || entry.client_id !== client.client_id) {
      throw new Error("Invalid refresh token");
    }
    return this._issueTokens(client);
  }

  async verifyAccessToken(token) {
    const entry = this.store.getAccess(token);
    if (!entry) {
      throw new Error("Invalid or expired access token");
    }
    return {
      token,
      clientId: entry.client_id,
      scopes: entry.scopes || [],
      expiresAt: entry.expiresAt
        ? Math.floor(entry.expiresAt / 1000)
        : undefined,
    };
  }

  async issueAuthorizationCode(client, params) {
    const code = `mcpac_${crypto.randomBytes(24).toString("hex")}`;
    const expiresAt = Date.now() + this.codeTtlSec * 1000;
    this.store.putCode(code, {
      client_id: client.client_id,
      code_challenge: params.codeChallenge,
      redirect_uri: params.redirectUri,
      scopes: params.scopes || [],
      state: params.state || null,
      expiresAt,
    });
    return code;
  }

  _issueTokens(client) {
    const access = `mcpat_${crypto.randomBytes(32).toString("hex")}`;
    const refresh = `mcprt_${crypto.randomBytes(32).toString("hex")}`;
    const expiresAt = Date.now() + this.accessTokenTtlSec * 1000;
    this.store.putAccess(access, {
      client_id: client.client_id,
      scopes: ["mcp"],
      expiresAt,
    });
    this.store.putRefresh(refresh, { client_id: client.client_id });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSec,
      refresh_token: refresh,
      scope: "mcp",
    };
  }
}

function mountMcpOAuth(app, opts) {
  const {
    storePath,
    consentSecret,
    issuerUrl,
    accessTokenTtlSec,
    codeTtlSec,
  } = opts;
  if (!consentSecret) {
    throw new Error(
      "mountMcpOAuth requires consentSecret (set MCP_BEARER_TOKEN).",
    );
  }
  if (!issuerUrl) {
    throw new Error("mountMcpOAuth requires issuerUrl (set APP_BASE_URL).");
  }

  const store = new OAuthStore(storePath);
  const provider = new FileOAuthProvider({
    store,
    accessTokenTtlSec,
    codeTtlSec,
  });

  app.post(
    "/oauth/approve",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      try {
        const consentToken = req.body.consent_token || "";
        const paramsB64 = req.body.params || "";
        const clientId = req.body.client_id || "";
        const client = provider.clientsStore.getClient(clientId);
        if (!client) {
          res.status(400).send("Unknown client.");
          return;
        }
        const params = JSON.parse(
          Buffer.from(paramsB64, "base64").toString("utf8"),
        );
        if (!timingSafeEqualStr(consentToken, consentSecret)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res
            .status(401)
            .send(
              renderConsentForm({
                client,
                params,
                error: "Incorrect consent token. Try again.",
              }),
            );
          return;
        }
        const code = await provider.issueAuthorizationCode(client, params);
        const redirect = new URL(params.redirectUri);
        redirect.searchParams.set("code", code);
        if (params.state) redirect.searchParams.set("state", params.state);
        res.redirect(302, redirect.toString());
      } catch (err) {
        console.error("[oauth] approve error:", err);
        res.status(500).send("Internal server error.");
      }
    },
  );

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(issuerUrl),
      scopesSupported: ["mcp"],
      resourceName: "Voice Agent Transcripts",
    }),
  );

  return {
    provider,
    requireAuth: requireBearerAuth({ verifier: provider }),
  };
}

module.exports = { mountMcpOAuth };
