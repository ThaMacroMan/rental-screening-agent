const http = require('http');
const httpProxy = require('http-proxy');

const VOICE_PORT = Number(process.env.VOICE_PORT || 8002);
const PROXY_PORT = Number(process.env.PROXY_PORT || process.env.PORT || 8001);

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
});

function route(req, res) {
  const url = req.url || '/';

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxyPort: PROXY_PORT, voicePort: VOICE_PORT }));
    return;
  }

  if (url.startsWith('/voice')) {
    console.log(`[voice] ${req.method} ${req.url}`);
    proxy.web(req, res, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  if (url.startsWith('/testing')) {
    console.log(`[testing] ${req.method} ${req.url}`);
    proxy.web(req, res, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  if (url.startsWith('/dashboard')) {
    console.log(`[dashboard] ${req.method} ${req.url}`);
    proxy.web(req, res, { target: `http://localhost:${VOICE_PORT}` });
    return;
  }

  if (url.startsWith('/formspree')) {
    console.log(`[formspree] ${req.method} ${req.url}`);
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
