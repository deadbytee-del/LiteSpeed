#!/usr/bin/env node
// Measures what LiteSpeed adds on top of a direct request.
//
//   node scripts/bench.mjs                       self-contained: local upstream, loopback only
//   node scripts/bench.mjs --url https://example.com --api http://127.0.0.1:8787 -n 40
//
// Self-contained mode isolates proxy overhead (no real network). Remote mode compares
// "direct from this machine" with "via the API", which also includes the API's own
// network position, so read it as a user-level comparison, not pure overhead.
import http from 'node:http';
import zlib from 'node:zlib';
import { createNodeServer } from '../src/adapters/node.js';
import { encodeOrigin } from '../src/url/codec.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const N = Number(arg('-n', 60));
const WARM = 8;
const remoteUrl = arg('--url');
const apiBase = arg('--api');

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { min: s[0], p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] }; };
const f = (n) => n.toFixed(1).padStart(7);

async function once(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers: { 'accept-encoding': 'identity', ...headers }, redirect: 'manual' });
  const ttfb = performance.now() - t0;
  const buf = await res.arrayBuffer();
  return { ttfb, total: performance.now() - t0, bytes: buf.byteLength, status: res.status, cache: res.headers.get('x-litespeed-cache') };
}

async function run(label, url, headers) {
  for (let i = 0; i < WARM; i++) await once(url, headers);
  const rs = [];
  for (let i = 0; i < N; i++) rs.push(await once(url, headers));
  const t = stats(rs.map((r) => r.ttfb));
  const tot = stats(rs.map((r) => r.total));
  console.log(`${label.padEnd(34)} ttfb p50 ${f(t.p50)} p95 ${f(t.p95)} | total p50 ${f(tot.p50)} p95 ${f(tot.p95)} ms | ${rs[0].bytes} B | ${rs[0].status}${rs[0].cache ? ' ' + rs[0].cache : ''}`);
  return { ttfb: t.p50, total: tot.p50 };
}

async function localSuite() {
  const html = '<!doctype html><html><head><title>bench</title><link rel="stylesheet" href="/a.css"></head><body>' +
    Array.from({ length: 1500 }, (_, i) => `<div class="row"><a href="/item/${i}?ref=bench">Item ${i}</a><img src="/img/${i}.png" alt=""><p>Lorem ipsum dolor sit amet ${i}</p></div>`).join('\n') + '</body></html>';
  const css = Array.from({ length: 800 }, (_, i) => `.c${i}{background:url(/img/${i}.png);color:#${(i * 4099 % 0xffffff).toString(16).padStart(6, '0')}}`).join('\n');
  const blob = Buffer.alloc(4 * 1024 * 1024, 7);
  const up = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    if (req.url === '/a.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    if (req.url === '/cached.css') { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=300' }); return res.end(css); }
    if (req.url === '/blob') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': blob.length }); return res.end(blob); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const { server } = createNodeServer({ env: { LITESPEED_ALLOW_PRIVATE: 'on' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${up.address().port}`;
  const P = `http://127.0.0.1:${server.address().port}/p/${encodeOrigin(U)}`;

  console.log(`self-contained, loopback, N=${N} (+${WARM} warm-up), html ${(html.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB\n`);
  const rows = [];
  for (const [name, path] of [['HTML (rewritten, streamed)', '/'], ['CSS (rewritten, buffered)', '/a.css'], ['4 MB binary (pass-through)', '/blob'], ['CSS with max-age (cache)', '/cached.css']]) {
    const d = await run(`direct   ${name}`, U + path);
    const p = await run(`proxied  ${name}`, P + path);
    rows.push([name, p.total - d.total, p.ttfb - d.ttfb]);
    console.log();
  }
  console.log('added by proxy (p50 differences):');
  for (const [n, tot, ttfb] of rows) console.log(`  ${n.padEnd(30)} +${tot.toFixed(1)} ms total, ${ttfb >= 0 ? '+' : ''}${ttfb.toFixed(1)} ms ttfb`);
  up.closeAllConnections?.(); server.closeAllConnections?.(); up.close(); server.close();
}

async function remoteSuite() {
  if (!apiBase) throw new Error('--api is required with --url');
  const target = new URL(remoteUrl);
  const proxied = `${apiBase.replace(/\/$/, '')}/p/${encodeOrigin(target.origin)}${target.pathname}${target.search}`;
  console.log(`remote: ${remoteUrl}\n        via ${apiBase}, N=${N}\n`);
  await run('direct', remoteUrl);
  await run('via LiteSpeed', proxied);
  const ping = await (await fetch(`${apiBase.replace(/\/$/, '')}/api/ping?url=${encodeURIComponent(remoteUrl)}`)).json();
  console.log(`\nAPI -> upstream round trip (/api/ping): ${ping.upstreamMs} ms  (the floor any proxy at that location pays)`);
}

await (remoteUrl ? remoteSuite() : localSuite());
