import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createNodeServer } from '../src/adapters/node.js';
import { encodeOrigin } from '../src/url/codec.js';

let upstream, proxy, UP, PX, hits;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  hits = { cached: 0, echo: [] };
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    switch (u.pathname) {
      case '/': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['sid=1; Path=/; HttpOnly', 'theme=dark; Domain=127.0.0.1'] }); return res.end('<html><head><title>T</title></head><body><a href="/next">n</a><img src="logo.png"></body></html>');
      case '/redirect': res.writeHead(302, { location: '/next?x=1' }); return res.end();
      case '/redirect-abs': res.writeHead(301, { location: 'https://other.example/z' }); return res.end();
      case '/style.css': res.writeHead(200, { 'content-type': 'text/css' }); return res.end('a{background:url(/bg.png)}');
      case '/cached.js': hits.cached++; res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=60' }); return res.end('console.log(1)');
      case '/gz': { const z = zlib.gzipSync('{"ok":true}'); res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(z.length) }); return res.end(z); }
      case '/echo': { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hits.echo.push({ method: req.method, cookie: req.headers.cookie, referer: req.headers.referer, origin: req.headers.origin, body: b }); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body: b })); }); return; }
      case '/range': if (req.headers.range) { res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' }); return res.end('abcd'); } res.writeHead(200); return res.end('0123456789');
      case '/frame-blocked': res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'" }); return res.end('<p>x</p>');
      case '/stream': { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first;'); setTimeout(() => res.end('second'), 150); return; }
      case '/hang': return; // never responds
      default: res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope');
    }
  });
  UP = await listen(upstream);
  const env = { LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_TIMEOUT_MS: '400', LITESPEED_ALLOWED_ORIGINS: 'https://me.github.io' };
  ({ server: proxy } = createNodeServer({ env }));
  PX = await listen(proxy);
});
after(() => { upstream.closeAllConnections?.(); proxy.closeAllConnections?.(); upstream.close(); proxy.close(); });

const P = (path = '/') => `${PX}/p/${encodeOrigin(UP)}${path}`;
const K = () => encodeOrigin(UP);

test('health and CORS', async () => {
  const r = await fetch(`${PX}/api/health`, { headers: { origin: 'https://me.github.io' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://me.github.io');
  const other = await fetch(`${PX}/api/health`, { headers: { origin: 'https://evil.test' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${PX}/api/health`, { method: 'OPTIONS', headers: { origin: 'https://me.github.io', 'access-control-request-method': 'GET' } });
  assert.equal(pre.status, 204);
});

test('HTML is rewritten, runtime injected, cookies scoped, security headers stripped', async () => {
  const r = await fetch(P('/'));
  const html = await r.text();
  assert.match(html, /<head><script src="\/api\/runtime\.js\?v=/);
  assert.match(html, new RegExp(`href="/p/${K()}/next"`));
  assert.match(html, new RegExp(`src="/p/${K()}/logo.png"`));
  const cookies = r.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every((c) => c.includes(`Path=/p/${K()}/`) && !/Domain=/i.test(c)));
  assert.match(r.headers.get('server-timing'), /upstream;dur=/);
  assert.equal(r.headers.get('x-litespeed-target'), `${UP}/`);
  const fb = await fetch(P('/frame-blocked'));
  assert.equal(fb.headers.get('x-frame-options'), null);
  assert.equal(fb.headers.get('content-security-policy'), null);
});

test('fetch-style requests (sec-fetch-dest: empty) get no runtime injection', async () => {
  const html = await (await fetch(P('/'), { headers: { 'sec-fetch-dest': 'empty' } })).text();
  assert.doesNotMatch(html, /runtime\.js/);
});

test('redirects are rewritten and not followed', async () => {
  const r = await fetch(P('/redirect'), { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/p/${K()}/next?x=1`);
  const a = await fetch(P('/redirect-abs'), { redirect: 'manual' });
  assert.equal(a.status, 301);
  assert.equal(a.headers.get('location'), `/p/${encodeOrigin('https://other.example')}/z`);
});

test('CSS is rewritten', async () => {
  assert.match(await (await fetch(P('/style.css'))).text(), new RegExp(`url\\("/p/${K()}/bg.png"\\)`));
});

test('upstream compressed bodies are decoded and framing headers fixed', async () => {
  const r = await fetch(P('/gz'), { headers: { 'accept-encoding': 'identity' } });
  assert.equal(r.headers.get('content-encoding'), null);
  assert.deepEqual(await r.json(), { ok: true });
});

test('responses are compressed for clients that ask', async () => {
  const r = await fetch(P('/'), { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.headers.get('content-encoding'), 'br');
  assert.match(await r.text(), /<title>T<\/title>/);
});

test('POST bodies, status codes, cookies and Referer/Origin translation', async () => {
  const r = await fetch(P('/echo'), {
    method: 'POST', body: 'hello=world',
    headers: { cookie: 'sid=1', referer: `${PX}/p/${K()}/page`, origin: PX, 'content-type': 'text/plain' },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { body: 'hello=world' });
  const seen = hits.echo.at(-1);
  assert.equal(seen.cookie, 'sid=1');
  assert.equal(seen.referer, `${UP}/page`);
  assert.equal(seen.origin, UP);
});

test('404 passes through with its status', async () => {
  const r = await fetch(P('/missing'));
  assert.equal(r.status, 404);
  assert.equal(await r.text(), 'nope');
});

test('range requests pass through as 206', async () => {
  const r = await fetch(P('/range'), { headers: { range: 'bytes=0-3' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(await r.text(), 'abcd');
});

test('bodies stream: first chunk arrives before upstream finishes', async () => {
  const t0 = Date.now();
  const r = await fetch(P('/stream'));
  const reader = r.body.getReader();
  const first = await reader.read();
  const tFirst = Date.now() - t0;
  assert.equal(new TextDecoder().decode(first.value), 'first;');
  assert.ok(tFirst < 120, `first chunk took ${tFirst}ms`);
  while (!(await reader.read()).done);
});

test('cacheable static resources are served from cache', async () => {
  const before = hits.cached;
  const a = await fetch(P('/cached.js'));
  await a.text();
  await new Promise((r) => setTimeout(r, 20));
  const b = await fetch(P('/cached.js'));
  assert.equal(b.headers.get('x-litespeed-cache'), 'HIT');
  assert.equal(await b.text(), 'console.log(1)');
  assert.equal(hits.cached - before, 1);
  const withCookie = await fetch(P('/cached.js'), { headers: { cookie: 'a=b' } });
  assert.equal(withCookie.headers.get('x-litespeed-cache'), 'BYPASS');
});

test('errors: timeout, bad target, blocked target, unreachable', async () => {
  const t = await fetch(P('/hang'), { headers: { accept: 'application/json' } });
  assert.equal(t.status, 504);
  assert.equal((await t.json()).error.code, 'upstream_timeout');

  const page = await fetch(P('/hang'), { headers: { accept: 'text/html' } });
  assert.equal(page.status, 504);
  assert.match(await page.text(), /Try again/);

  const bad = await fetch(`${PX}/api/resolve?url=${encodeURIComponent('http://[bad')}`);
  assert.equal(bad.status, 400);

  const tmp = http.createServer();
  const closed = await listen(tmp);
  await new Promise((r) => tmp.close(r));
  const dead = await fetch(`${PX}/p/${encodeOrigin(closed)}/`, { headers: { accept: 'application/json' } });
  assert.equal(dead.status, 502);
  assert.equal((await dead.json()).error.code, 'connection_refused');

  const bp = await fetch(`${PX}/p/${encodeOrigin('http://example.com:6667')}/`, { headers: { accept: 'application/json' } });
  assert.equal((await bp.json()).error.code, 'blocked_port');

  const nf = await fetch(`${PX}/nothing`);
  assert.equal(nf.status, 404);
});

test('private targets are refused by default config', async () => {
  const { server } = createNodeServer({ env: {} });
  const base = await listen(server);
  const r = await fetch(`${base}/p/${encodeOrigin(UP)}/`, { headers: { accept: 'application/json' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'private_target');
  const ping = await fetch(`${base}/api/ping?url=${encodeURIComponent('http://169.254.169.254/')}`);
  assert.equal(ping.status, 403);
  server.close();
});

test('root-relative requests that escaped rewriting are recovered via Referer', async () => {
  const r = await fetch(`${PX}/style.css`, { redirect: 'manual', headers: { referer: `${PX}/p/${K()}/dir/page` } });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), `/p/${K()}/style.css`);
});

test('/api/ping reports upstream latency; /api/go redirects', async () => {
  const p = await (await fetch(`${PX}/api/ping?url=${encodeURIComponent(UP + '/')}`)).json();
  assert.equal(p.status, 200);
  assert.ok(p.upstreamMs >= 0);
  const g = await fetch(`${PX}/api/go?url=${encodeURIComponent(UP + '/x')}`, { redirect: 'manual' });
  assert.equal(g.status, 302);
  assert.equal(g.headers.get('location'), `/p/${K()}/x`);
});
