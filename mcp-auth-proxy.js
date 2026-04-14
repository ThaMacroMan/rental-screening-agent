const http = require('http');
const httpProxy = require('http-proxy');

const VOICE_PORT = Number(process.env.VOICE_PORT || 8002);
const PROXY_PORT = Number(process.env.PROXY_PORT || process.env.PORT || 8001);

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error(`[proxy] upstream error for ${req?.method} ${req?.url}: ${err.code || err.message}`);
  if (res && !res.headersSent) {
    try {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Bad gateway',
          detail: err.code || err.message,
        }),
      );
    } catch {}
  } else if (res && typeof res.destroy === 'function') {
    try { res.destroy(); } catch {}
  }
});

process.on('uncaughtException', (err) => {
  console.error('[proxy] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[proxy] unhandledRejection:', reason);
});

const FORWARD_PREFIXES = [
  '/voice',
  '/testing',
  '/dashboard',
  '/formspree',
  '/mcp',
  '/.well-known/oauth-',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/oauth/',
];

function shouldForward(url) {
  return FORWARD_PREFIXES.some(
    (prefix) =>
      url === prefix ||
      url.startsWith(`${prefix}/`) ||
      url.startsWith(`${prefix}?`) ||
      url.startsWith(prefix),
  );
}

function route(req, res) {
  const url = req.url || '/';

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxyPort: PROXY_PORT, voicePort: VOICE_PORT }));
    return;
  }

  if (shouldForward(url)) {
    console.log(`[proxy] ${req.method} ${req.url}`);
    proxy.web(req, res, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(route);

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';

  if (url.startsWith('/voice/stream')) {
    proxy.ws(req, socket, head, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  socket.destroy();
});

server.listen(PROXY_PORT, () => {
  console.log(`Gateway listening on port ${PROXY_PORT}`);
});
