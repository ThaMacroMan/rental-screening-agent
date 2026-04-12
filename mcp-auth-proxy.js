const http = require('http');
const httpProxy = require('http-proxy');
const { timingSafeEqual } = require('crypto');

const MCP_PORT = Number(process.env.MCP_PORT || 8000);
const VOICE_PORT = Number(process.env.VOICE_PORT || 8002);
const PROXY_PORT = Number(process.env.PROXY_PORT || process.env.PORT || 8001);
const EXPECTED_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;

if (!EXPECTED_BEARER_TOKEN) {
  throw new Error('Missing MCP_BEARER_TOKEN in environment.');
}

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
});

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const expected = Buffer.from(`Bearer ${EXPECTED_BEARER_TOKEN}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function route(req, res) {
  const url = req.url || '/';

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxyPort: PROXY_PORT, mcpPort: MCP_PORT, voicePort: VOICE_PORT }));
    return;
  }

  if (url.startsWith('/mcp')) {
    if (!isAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    console.log(`[proxy] ${req.method} ${req.url} | accept=${req.headers.accept || 'NONE'}`);
    req.headers.accept = 'application/json, text/event-stream';
    proxy.web(req, res, { target: `http://localhost:${MCP_PORT}` });
    return;
  }

  if (url.startsWith('/voice')) {
    console.log(`[voice] ${req.method} ${req.url}`);
    proxy.web(req, res, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(route);

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';

  if (url.startsWith('/mcp')) {
    if (!isAuthorized(req)) {
      socket.destroy();
      return;
    }

    req.headers.accept = 'application/json, text/event-stream';
    proxy.ws(req, socket, head, { target: `http://localhost:${MCP_PORT}` });
    return;
  }

  socket.destroy();
});

server.listen(PROXY_PORT, () => {
  console.log(`Gateway listening on port ${PROXY_PORT}`);
});
