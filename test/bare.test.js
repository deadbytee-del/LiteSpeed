import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createNodeServer } from '../src/adapters/node.js';

let upstream, wss, proxy, UP, PX, closeProxy;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/echo') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'] }); res.end(JSON.stringify({ method: req.method, body: b, ua: req.headers['user-agent'], cookie: req.headers.cookie, x: req.headers['x-custom'] })); }); return; }
    if (u.pathname === '/redirect') { res.writeHead(302, { location: '/echo' }); return res.end(); }
    if (u.pathname === '/nocontent') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/hang') return;
    res.writeHead(404, 'Nope Ü'); res.end('nf');
  });
  wss = new WebSocketServer({ server: upstream, handleProtocols: (p) => (p.has('chat') ? 'chat' : false) });
  wss.on('connection', (ws, req) => { ws.send(`hello origin=${req.headers.origin}`); ws.on('message', (d, bin) => ws.send(d, { binary: bin })); });
  UP = await listen(upstream);
  ({ server: proxy, close: closeProxy } = createNodeServer({ env: { LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_TIMEOUT_MS: '300', LITESPEED_ALLOWED_ORIGINS: 'https://me.github.io' } }));
  PX = await listen(proxy);
});
after(() => { upstream.closeAllConnections?.(); proxy.closeAllConnections?.(); wss.close(); upstream.close(); closeProxy(); });

const bare = (url, { method = 'GET', headers = {}, body, extra = {} } = {}) =>
  fetch(`${PX}/bare/v3/`, { method, body, headers: { 'x-bare-url': url, 'x-bare-headers': JSON.stringify(headers), ...extra } });

test('manifest lists v3', async () => {
  const m = await (await fetch(`${PX}/bare/`)).json();
  assert.deepEqual(m.versions, ['v3']);
});

test('relays method, headers, body; returns status/headers/cookies in X-Bare-*', async () => {
  const r = await bare(`${UP}/echo`, { method: 'POST', body: 'payload', headers: { 'user-agent': 'TestUA/1', 'x-custom': 'yes', cookie: 'sid=9' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-bare-status'), '201');
  const meta = JSON.parse(r.headers.get('x-bare-headers'));
  assert.deepEqual(meta['set-cookie'], ['a=1; Path=/', 'b=2; HttpOnly']);
  assert.equal(meta['content-type'], 'application/json');
  assert.deepEqual(await r.json(), { method: 'POST', body: 'payload', ua: 'TestUA/1', cookie: 'sid=9', x: 'yes' });
});

test('redirects are reported, not followed; status text survives; bodiless statuses', async () => {
  const r = await bare(`${UP}/redirect`);
  assert.equal(r.headers.get('x-bare-status'), '302');
  assert.equal(JSON.parse(r.headers.get('x-bare-headers')).location, '/echo');
  const nf = await bare(`${UP}/nothing`);
  assert.equal(nf.headers.get('x-bare-status'), '404');
  assert.match(nf.headers.get('x-bare-status-text'), /Nope/);
  assert.equal(await nf.text(), 'nf');
  const nc = await bare(`${UP}/nocontent`);
  assert.equal(nc.headers.get('x-bare-status'), '204');
  assert.equal(await nc.text(), '');
});

test('forward and pass headers', async () => {
  const r = await bare(`${UP}/echo`, { extra: { 'x-bare-forward-headers': 'accept-language', 'x-bare-pass-headers': 'content-type', 'accept-language': 'fr' } });
  assert.equal(r.headers.get('content-type'), 'application/json');
  const r2 = await fetch(`${PX}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/nocontent`, 'x-bare-headers': '{}', 'x-bare-pass-status': '204' } });
  assert.equal(r2.status, 204);
});

test('errors: missing/invalid headers, timeout, CORS preflight', async () => {
  assert.equal((await fetch(`${PX}/bare/v3/`)).status, 400);
  assert.equal((await fetch(`${PX}/bare/v3/`, { headers: { 'x-bare-url': 'nope', 'x-bare-headers': '{}' } })).status, 400);
  assert.equal((await fetch(`${PX}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/`, 'x-bare-headers': '{bad' } })).status, 400);
  const t = await bare(`${UP}/hang`);
  assert.equal(t.status, 504);
  const pre = await fetch(`${PX}/bare/v3/`, { method: 'OPTIONS', headers: { origin: 'https://me.github.io', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-bare-url,x-bare-headers' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://me.github.io');
  assert.match(pre.headers.get('access-control-allow-headers'), /x-bare-url/);
  const ok = await bare(`${UP}/echo`);
  assert.match(ok.headers.get('access-control-expose-headers'), /x-bare-headers/);
});

test('private targets are refused on the relay with default config', async () => {
  const { server, close } = createNodeServer({ env: {} });
  const base = await listen(server);
  const r = await fetch(`${base}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/echo`, 'x-bare-headers': '{}' } });
  assert.equal(r.status, 403);
  close();
});

// Messages are queued from construction so a greeting sent right after the handshake is never missed.
const wsOpen = (url, protocols, opts) => new Promise((res, rej) => {
  const ws = new WebSocket(url, protocols, opts);
  ws.q = []; ws.waiters = [];
  ws.on('message', (d, bin) => { const w = ws.waiters.shift(); if (w) w({ d, bin }); else ws.q.push({ d, bin }); });
  ws.once('open', () => res(ws)); ws.once('error', rej);
  ws.once('unexpected-response', (_, r) => rej(new Error('HTTP ' + r.statusCode)));
});
const next = (ws) => new Promise((r) => (ws.q.length ? r(ws.q.shift()) : ws.waiters.push(r)));

test('websocket relay: text, binary, subprotocol and Origin', async () => {
  const wsUrl = UP.replace('http', 'ws');
  const ws = await wsOpen(`${PX.replace('http', 'ws')}/api/ws?url=${encodeURIComponent(wsUrl + '/sock')}&origin=${encodeURIComponent('https://site.example')}`, ['chat', 'other'], { origin: 'https://me.github.io' });
  assert.equal(ws.protocol, 'chat');
  const hello = await next(ws);
  assert.equal(hello.d.toString(), 'hello origin=https://site.example');
  ws.send('ping'); assert.equal((await next(ws)).d.toString(), 'ping');
  const buf = Buffer.from([1, 2, 3, 255]);
  ws.send(buf); const b = await next(ws);
  assert.ok(b.bin); assert.deepEqual([...b.d], [...buf]);
  const closed = new Promise((r) => ws.once('close', r));
  ws.close(1000); await closed;
});

test('websocket relay refuses bad origin, private target and missing url', async () => {
  const base = PX.replace('http', 'ws');
  await assert.rejects(wsOpen(`${base}/api/ws?url=${encodeURIComponent('ws://example.com/')}`, [], { origin: 'https://evil.test' }), /403/);
  await assert.rejects(wsOpen(`${base}/api/ws`, [], { origin: 'https://me.github.io' }), /400/);
  const { server, close } = createNodeServer({ env: {} });
  const b2 = (await listen(server)).replace('http', 'ws');
  await assert.rejects(wsOpen(`${b2}/api/ws?url=${encodeURIComponent(UP.replace('http', 'ws') + '/sock')}`), /403/);
  close();
});

test('overload returns 503 and per-client rate limit returns 429, quickly', async () => {
  const { server, close } = createNodeServer({ env: { LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_TIMEOUT_MS: '2000', LITESPEED_MAX_INFLIGHT: '1' } });
  const base = await listen(server);
  const slow = fetch(`${base}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/hang`, 'x-bare-headers': '{}' } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  const r = await fetch(`${base}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/echo`, 'x-bare-headers': '{}' } });
  assert.equal(r.status, 503);
  assert.ok(r.headers.get('retry-after'));
  assert.ok(Date.now() - t0 < 200);
  server.closeAllConnections?.(); close(); await slow;

  const rl = createNodeServer({ env: { LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_RATE_LIMIT: '2' } });
  const b2 = await listen(rl.server);
  const codes = [];
  for (let i = 0; i < 40; i++) codes.push((await fetch(`${b2}/bare/v3/`, { headers: { 'x-bare-url': `${UP}/nocontent`, 'x-bare-headers': '{}' } })).status);
  assert.ok(codes.includes(429), codes.join(','));
  assert.equal(codes[0], 200);
  rl.close();
});
