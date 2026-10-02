#!/usr/bin/env node
// Page-load time through the service worker with an HTTP/1.1 relay vs an HTTP/2 relay (self-signed cert, loopback).
// Upstream is a synthetic page with N images that each take DELAY ms to produce, so the result isolates connection limits.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNodeServer } from '../src/adapters/node.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
let pw;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) { try { pw = req(spec); break; } catch { /* next */ } }
if (!pw) { console.log('playwright not found'); process.exit(0); }
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
const N = Number(process.env.N || 150); const DELAY = Number(process.env.DELAY || 80); const RUNS = Number(process.env.RUNS || 3);
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-h2-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`, '-out', `${tmp}/c.pem`, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });

const upstream = http.createServer((q, res) => {
  if (q.url.startsWith('/img/')) return setTimeout(() => { res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#80f"/></svg>'); }, DELAY);
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>bench</title>' + Array.from({ length: N }, (_, i) => `<img src="/img/${i}.svg?r=${Math.random()}" width="8" height="8">`).join(''));
});
const upPort = await listen(upstream);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const pages = http.createServer((q, res) => { const u = new URL(q.url, 'http://x'); let p = path.join(root, 'web', u.pathname.slice('/LiteSpeed/'.length)); try { if (fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); const b = fs.readFileSync(p); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/plain' }); res.end(b); } catch { res.writeHead(404); res.end(); } });
const pagesPort = await listen(pages);

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--ignore-certificate-errors'] });
const results = {};
for (const proto of ['http/1.1', 'h2']) {
  const env = { LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_CACHE: 'off', LITESPEED_ADBLOCK: 'off', ...(proto === 'h2' ? { LITESPEED_TLS_KEY: `${tmp}/k.pem`, LITESPEED_TLS_CERT: `${tmp}/c.pem` } : {}) };
  const { server, close } = createNodeServer({ env });
  const apiPort = await listen(server);
  const api = `${proto === 'h2' ? 'https' : 'http'}://127.0.0.1:${apiPort}`;
  const times = [];
  for (let r = 0; r < RUNS; r++) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${pagesPort}/LiteSpeed/?api=${encodeURIComponent(api)}`);
    await page.waitForSelector('#status-pill[data-state="ok"]', { timeout: 15000 });
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ls.settings') || '{}'); s.adblock = false; localStorage.setItem('ls.settings', JSON.stringify(s)); });
    await page.reload(); await page.waitForSelector('#status-pill[data-state="ok"]');
    const t0 = Date.now();
    await page.fill('#home-input', `http://127.0.0.1:${upPort}/`); await page.keyboard.press('Enter');
    const frame = page.frames().find((f) => f !== page.mainFrame()) || page.mainFrame();
    await page.waitForFunction((n) => { const f = document.getElementById('frame'); try { const d = f.contentDocument; return d && d.images.length >= n && [...d.images].every((i) => i.complete && i.naturalWidth > 0); } catch { return false; } }, N, { timeout: 60000 });
    times.push(Date.now() - t0);
    await ctx.close();
  }
  results[proto] = times;
  console.log(`${proto.padEnd(9)} ${N} images x ${DELAY} ms upstream: ${times.map((t) => t + ' ms').join(', ')}  (median ${[...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]} ms)`);
  server.closeAllConnections?.(); close();
}
await browser.close(); upstream.closeAllConnections?.(); upstream.close(); pages.close(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
