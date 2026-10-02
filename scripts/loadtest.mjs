#!/usr/bin/env node
// Closed-loop load test of the relay and server-rewrite paths.
//   node scripts/loadtest.mjs                         self-contained: spawns an upstream + LiteSpeed with 1 worker, then N workers
//   node scripts/loadtest.mjs --api http://host:8787 --url https://example.com/ -c 64 -d 10
// Run the load generator on a different machine from the server for numbers that mean anything.
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Agent, fetch as ufetch } from 'undici';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const C = Number(arg('-c', 64));
const D = Number(arg('-d', 8));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (s) => Buffer.from(s).toString('base64url');

async function drive(label, makeReq, { c = C, seconds = D } = {}) {
  const agent = new Agent({ connections: c, pipelining: 1, keepAliveTimeout: 30000 });
  const lat = []; let errors = 0; let bytes = 0;
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: c }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      try {
        const { url, init } = makeReq();
        const r = await ufetch(url, { ...init, dispatcher: agent });
        const b = await r.arrayBuffer();
        if (r.status >= 500 || r.status === 429) errors++; else { lat.push(performance.now() - t); bytes += b.byteLength; }
      } catch { errors++; }
    }
  }));
  await agent.close();
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  const rps = lat.length / seconds;
  console.log(`${label.padEnd(34)} ${rps.toFixed(0).padStart(6)} req/s  p50 ${q(0.5).toFixed(1).padStart(6)}  p95 ${q(0.95).toFixed(1).padStart(6)}  p99 ${q(0.99).toFixed(1).padStart(6)} ms  errors ${errors}  ${(bytes / seconds / 1e6).toFixed(1)} MB/s`);
  return rps;
}

async function remote() {
  const api = arg('--api'); const target = new URL(arg('--url'));
  console.log(`c=${C}, ${D}s each\n`);
  await drive('relay  GET', () => ({ url: `${api}/bare/v3/`, init: { headers: { 'x-bare-url': target.href, 'x-bare-headers': '{}' } } }));
  await drive('server GET /p/ (rewrite)', () => ({ url: `${api}/p/${b64(target.origin)}${target.pathname}${target.search}`, init: {} }));
}

async function selfContained() {
  const html = '<!doctype html><html><head><title>t</title></head><body>' + Array.from({ length: 300 }, (_, i) => `<div><a href="/p${i}">l${i}</a><img src="/i${i}.png"></div>`).join('') + '</body></html>';
  const up = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${up.address().port}`;
  const cpus = os.availableParallelism();
  console.log(`${cpus} CPU(s) shared by upstream, server and load generator; c=${C}, ${D}s per run; upstream page ${(html.length / 1024).toFixed(0)} KB\n`);

  for (const workers of [...new Set([1, Math.min(cpus, 4)])]) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn('node', ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), LITESPEED_WORKERS: String(workers), LITESPEED_ALLOW_PRIVATE: 'on', LITESPEED_ADBLOCK: 'on' }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    console.log(`--- ${workers} worker(s) ---`);
    await drive('relay  (bare v3, no rewriting)', () => ({ url: `http://127.0.0.1:${port}/bare/v3/`, init: { headers: { 'x-bare-url': U + '/', 'x-bare-headers': '{}' } } }));
    await drive('server rewrite (HTML, 300 links)', () => ({ url: `http://127.0.0.1:${port}/p/${b64(U)}/`, init: {} }));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
  up.closeAllConnections?.(); up.close();
}

await (arg('--api') ? remote() : selfContained());
process.exit(0);
