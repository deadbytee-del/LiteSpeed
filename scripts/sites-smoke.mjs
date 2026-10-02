#!/usr/bin/env node
// Loads real sites through the static (service worker) stack and reports what happened. Needs network + playwright.
//   node scripts/sites-smoke.mjs [url ...]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createNodeServer } from '../src/adapters/node.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
let pw;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) { try { pw = req(spec); break; } catch { /* next */ } }
if (!pw) { console.log('playwright not found'); process.exit(0); }
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const pages = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x');
  let p = path.join(root, 'web', decodeURIComponent(u.pathname.slice('/LiteSpeed/'.length)));
  try { if (fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); const b = fs.readFileSync(p); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/plain' }); res.end(b); } catch { res.writeHead(404); res.end(); }
});
const { server: api, close } = createNodeServer({ env: { LITESPEED_UPSTREAM_PROXY: process.env.LITESPEED_UPSTREAM_PROXY || '' } });
const [pp, ap] = [await listen(pages), await listen(api)];
const SHELL = `http://127.0.0.1:${pp}/LiteSpeed/?api=http://127.0.0.1:${ap}`;

const sites = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://example.com/', 'https://en.wikipedia.org/wiki/Web_proxy', 'https://news.ycombinator.com/', 'https://html.duckduckgo.com/html/?q=litespeed+proxy',
  'https://www.bbc.com/news', 'https://github.com/', 'https://developer.mozilla.org/en-US/', 'https://www.reddit.com/', 'https://stackoverflow.com/questions',
];
const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
for (const url of sites) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 140)));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/p/')) failed.push(r.status()); });
  const t0 = Date.now();
  await page.goto(SHELL);
  await page.waitForSelector('#status-pill[data-state="ok"]', { timeout: 15000 });
  await page.fill('#home-input', url); await page.keyboard.press('Enter');
  let title = ''; let note = '';
  try {
    await page.waitForFunction(() => /–/.test(document.title) && document.title !== 'LiteSpeed', null, { timeout: 40000 });
    title = await page.title();
  } catch { note = 'no title/nav message'; }
  await page.waitForTimeout(2500);
  const f = page.frames().find((x) => x.url().includes('/p/'));
  let text = 0; let imgs = 0; let broken = 0;
  try { ({ text, imgs, broken } = await f.evaluate(() => ({ text: document.body ? document.body.innerText.length : 0, imgs: document.images.length, broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length }))); } catch (e) { note += ' eval:' + e.message.slice(0, 40); }
  const blocked = await page.textContent('#shield span');
  const timing = await page.textContent('#timing').catch(() => '');
  const name = new URL(url).hostname;
  await page.screenshot({ path: `/tmp/ls-site-${name}.png` });
  results.push({ name, ms: Date.now() - t0, title: title.slice(0, 48), text, imgs, broken, blocked: blocked || 0, failed: failed.length, errors: errors.length, note });
  console.log(JSON.stringify(results.at(-1)));
  if (process.env.VERBOSE) console.log('   errors:', errors.slice(0, 5), 'timing:', timing);
  await ctx.close();
}
await browser.close(); close(); api.closeAllConnections?.(); pages.close();
process.exit(0);
