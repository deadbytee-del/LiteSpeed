#!/usr/bin/env node
// Real-browser end-to-end test of the static (service worker) mode.
//   node scripts/browser-test.mjs            (needs `playwright` + a Chromium; set PLAYWRIGHT_MODULE / CHROMIUM_PATH if not discoverable)
// Topology mirrors production: "Pages" (web/ served under /LiteSpeed/) on one origin, the relay on another, an upstream site on a third.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createNodeServer } from '../src/adapters/node.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
let pw;
for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) { try { pw = req(spec); break; } catch { /* next */ } }
if (!pw) { console.log('playwright not found; skipping browser test'); process.exit(0); }
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => fs.existsSync(p));

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/* --- "GitHub Pages": web/ served under /LiteSpeed/ --- */
const pages = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x');
  if (!u.pathname.startsWith('/LiteSpeed/')) { res.writeHead(404); return res.end('pages 404'); }
  let p = path.join(root, 'web', decodeURIComponent(u.pathname.slice('/LiteSpeed/'.length)));
  try { if (fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); } catch { /* 404 below */ }
  try { const b = fs.readFileSync(p); res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/plain' }); res.end(b); } catch { res.writeHead(404); res.end('pages 404'); }
});

/* --- upstream site --- */
const sessions = new Set();
let clip = null;
const upstream = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x');
  const html = (b, h = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...h }); res.end(b); };
  const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  const cookies = Object.fromEntries((q.headers.cookie || '').split('; ').filter(Boolean).map((c) => c.split('=')));
  if (u.pathname === '/' || u.pathname.startsWith('/app')) {
    return html(`<!doctype html><html><head><title>Upstream App</title><link rel="stylesheet" href="/site.css"><script src="/pagead/js/adsbygoogle.js"></script></head><body>
<h1 id="h">app</h1><div class="adsbygoogle" id="ad">AD</div>
<nav><a id="spa" href="/app/page">spa</a> <a id="redir" href="/redirect">redir</a> <a id="abs" href="http://127.0.0.1:${upstream.address().port}/plain">abs</a></nav>
<form id="f" method="post" action="/submit"><input name="q" value="hello"><button>go</button></form>
<img id="img" src="/pix.svg"><div id="info"></div>
<script>
window.__info = {};
window.__info.pathname = location.pathname; window.__info.href = location.href; window.__info.origin = location.origin; window.__info.host = location.host;
window.__info.top = (top === self); window.__info.docURL = document.URL;
window.__info.adLoaded = !!window.__adLoaded;
document.cookie = 'visible=1; path=/';
localStorage.setItem('k','v'); window.__info.ls = localStorage.getItem('k');
fetch('/me').then(r=>r.json()).then(j=>{window.__info.me=j});
fetch('/login',{method:'POST',body:'u=1'}).then(()=>fetch('/me')).then(r=>r.json()).then(j=>{window.__info.meAfter=j; document.getElementById('h').textContent='ready'});
// SPA router
window.navigateSpa = (p) => { history.pushState({}, '', p); window.__info.spaPath = location.pathname; document.getElementById('info').textContent = 'route:' + location.pathname; };
document.getElementById('spa').addEventListener('click', (e) => { e.preventDefault(); navigateSpa('/app/page'); });
window.addEventListener('popstate', () => { window.__info.popPath = location.pathname; });
// websocket
const ws = new WebSocket('ws://127.0.0.1:${upstream.address().port}/ws'); ws.onmessage = (m) => { window.__info.ws = m.data; }; ws.onopen = () => ws.send('hi');
// ad popup (no user gesture) and location assignment helper
window.__info.popup = window.open('/plain') === null ? 'blocked' : 'opened';
window.goAbs = () => { location.href = 'http://127.0.0.1:${upstream.address().port}/plain?via=assign'; };
window.__info.destructured = (() => { const { top: o, self: t } = window; try { return [o !== t, typeof o.location.search] } catch (e) { return 'ERR ' + e.message } })();
window.__info.pm = 'pending';
{ const fr = document.createElement('iframe'); document.body.appendChild(fr);
  window.addEventListener('message', (e) => { if (e.data === 'echo:ping') window.__info.pm = 'ok:' + (e.source === fr.contentWindow); });
  fr.contentWindow.document.write('<script>addEventListener("message", (e) => e.source.postMessage("echo:" + e.data, "*"))<' + '/script>'); fr.contentWindow.document.close();
  // the page addresses the child with its (virtual) upstream origin, which is not the real origin
  fr.contentWindow.postMessage('ping', location.origin); }
window.docLoc = () => document.location.pathname + '|' + window.location.search + '|' + new URL(location.href).pathname;
</script></body></html>`);
  }
  if (u.pathname === '/leaks') {
    return html(`<!doctype html><title>leaks</title><style>#a,#b,#c{width:12px;height:12px;display:block}</style><div id="host"></div><div id="a"></div><div id="b"></div><div id="c"></div><svg width="10" height="10"><use id="u" /></svg>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<img id="sh" src="/pix.svg?shadow">';
document.getElementById('a').style.backgroundImage = 'url(/pix.svg?cssom)';
document.getElementById('b').style.cssText = 'background: url("/pix.svg?csstext")';
const st = document.createElement('style'); st.textContent = '#c{background:url(/pix.svg?styletext)}'; document.head.appendChild(st);
const sheet = new CSSStyleSheet(); sheet.replaceSync('#a{border-image:url(/pix.svg?constructed) 1}'); document.adoptedStyleSheets = [sheet];
const t = document.createElement('template'); t.innerHTML = '<img id="tpl" src="/pix.svg?template">'; document.body.appendChild(t.content.cloneNode(true));
document.getElementById('u').setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '/pix.svg?svguse#x');
const im = document.createElementNS('http://www.w3.org/2000/svg', 'image'); im.setAttribute('href', '/pix.svg?svgimage'); document.querySelector('svg').appendChild(im);
</script>`);
  }
  if (u.pathname === '/video') return html('<!doctype html><title>video</title><video id="v" src="/clip.webm" muted autoplay loop playsinline width="160"></video>');
  if (u.pathname === '/clip.webm') {
    if (!clip) { res.writeHead(404); return res.end(); }
    const range = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (!range) { res.writeHead(200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': clip.length }); return res.end(clip); }
    const a = range[1] === '' ? 0 : Number(range[1]); const b = range[2] === '' ? clip.length - 1 : Math.min(Number(range[2]), clip.length - 1);
    res.writeHead(206, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${clip.length}`, 'content-length': b - a + 1 });
    return res.end(clip.subarray(a, b + 1));
  }
  if (u.pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('h1{color:rgb(1,2,3)} #bg{background:url(/pix.svg)}'); }
  if (u.pathname === '/pix.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5"/></svg>'); }
  if (u.pathname === '/pagead/js/adsbygoogle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.__adLoaded = true;'); }
  if (u.pathname === '/login') { sessions.add('s1'); res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=s1; Path=/; HttpOnly', 'pref=dark; Path=/; Max-Age=3600'] }); return res.end('{"ok":true}'); }
  if (u.pathname === '/me') return json({ loggedIn: sessions.has(cookies.sid), cookie: q.headers.cookie || '' });
  if (u.pathname === '/redirect') { res.writeHead(302, { location: '/plain?from=redirect', 'set-cookie': 'hop=1; Path=/' }); return res.end(); }
  if (u.pathname === '/plain') return html(`<title>Plain</title><p id="p">plain ${u.search}</p><script>document.title='Plain '+location.search;</script>`);
  if (u.pathname === '/submit') { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => html(`<title>Submitted</title><p id="p">posted:${b}|origin:${q.headers.origin}|ref:${q.headers.referer}</p>`)); return; }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nf');
});
new WebSocketServer({ server: upstream, path: '/ws' }).on('connection', (ws) => ws.on('message', (d) => ws.send('echo:' + d)));

const upPort = await listen(upstream);
const { server: api, close: closeApi } = createNodeServer({ env: { LITESPEED_ALLOW_PRIVATE: 'on' } });
const apiPort = await listen(api);
const pagesPort = await listen(pages);
const SHELL = `http://127.0.0.1:${pagesPort}/LiteSpeed/`;
const UP = `http://127.0.0.1:${upPort}`;
const UPORIGIN = UP;

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
// A short WebM recorded by the browser itself (no external tools needed).
{
  const rec = await ctx.newPage();
  await rec.goto('about:blank');
  const b64 = await rec.evaluate(async () => {
    if (!window.MediaRecorder) return null;
    const c = document.createElement('canvas'); c.width = 160; c.height = 90; const g = c.getContext('2d');
    const stream = c.captureStream(15); const mr = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; mr.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (mr.onstop = r)); mr.start(100);
    let n = 0; const t = setInterval(() => { g.fillStyle = `hsl(${(n++ * 20) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 90); }, 50);
    await new Promise((r) => setTimeout(r, 2500)); clearInterval(t); mr.stop(); await done;
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
    return btoa(s);
  });
  await rec.close();
  if (b64) clip = Buffer.from(b64, 'base64');
}
let passed = 0;
const check = (name, fn) => fn().then(() => { passed++; console.log('  ok  ' + name); }, (e) => { problems.push(`${name}: ${e.message}`); console.log('  FAIL ' + name + '\n       ' + e.message.split('\n')[0]); });

await page.goto(`${SHELL}?api=http://127.0.0.1:${apiPort}`);
await page.waitForSelector('#status-pill[data-state="ok"]');
await check('static shell detects relay and registers the service worker', async () => {
  assert.match(await page.textContent('#status-pill'), /Static proxy/);
  const reg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
  assert.ok(reg);
});

await page.fill('#home-input', UP + '/');
await page.keyboard.press('Enter');
const frame = page.frameLocator('#frame');
await frame.locator('#h').filter({ hasText: 'ready' }).waitFor({ timeout: 15000 });
const f = page.frames().find((x) => x.url().includes('/p/'));
const info = () => f.evaluate(() => JSON.parse(JSON.stringify(window.__info)));
await page.waitForTimeout(600);

await check('page is loaded via the static scope, not the relay origin', async () => {
  assert.ok(f.url().startsWith(`${SHELL}p/`), f.url());
});
await check('location APIs report the real upstream URL (SPA-safe)', async () => {
  const i = await info();
  assert.equal(i.pathname, '/'); assert.equal(i.href, UP + '/'); assert.equal(i.origin, UP); assert.equal(i.host, `127.0.0.1:${upPort}`); assert.equal(i.docURL, UP + '/');
});
await check('destructured top and postMessage with the upstream origin work (shell realm + about:blank iframe)', async () => {
  await f.waitForFunction(() => window.__info.pm !== 'pending', null, { timeout: 5000 });
  const i = await info();
  assert.deepEqual(i.destructured, [true, 'string']);
  assert.equal(i.pm, 'ok:true');
});
await check('frame-busting sees top === self', async () => assert.equal((await info()).top, true));
await check('cookies: HttpOnly session sent upstream, scripts see only non-HttpOnly', async () => {
  const i = await info();
  assert.equal(i.me.loggedIn, false);
  assert.equal(i.meAfter.loggedIn, true);
  assert.match(i.meAfter.cookie, /sid=s1/);
  const dc = await f.evaluate(() => document.cookie);
  assert.match(dc, /visible=1/); assert.doesNotMatch(dc, /sid=/);
});
await check('localStorage works and is namespaced', async () => {
  assert.equal((await info()).ls, 'v');
  assert.equal(await page.evaluate(() => localStorage.getItem('k')), null);
});
await check('subresources: css, images', async () => {
  assert.equal(await f.evaluate(() => getComputedStyle(document.getElementById('h')).color.replace(/\s/g, '')), 'rgb(1,2,3)');
  assert.equal(await f.evaluate(() => document.getElementById('img').naturalWidth), 5);
});
await check('ad blocker: ad script blocked, ad container hidden, counter shown', async () => {
  const i = await info();
  assert.equal(i.adLoaded, false);
  assert.equal(await f.evaluate(() => getComputedStyle(document.getElementById('ad')).display), 'none');
  await page.waitForFunction(() => Number(document.querySelector('#shield span').textContent) >= 1, null, { timeout: 5000 });
});
await check('popup without a user gesture is blocked', async () => {
  // Playwright's evaluate() counts as a user gesture, so probe from a timer once transient activation (~5 s) has expired.
  await f.evaluate(() => { setTimeout(() => { window.__popup = [navigator.userActivation.isActive, window.open('/plain') === null]; }, 5600); });
  await f.waitForFunction(() => window.__popup, null, { timeout: 9000 });
  assert.deepEqual(await f.evaluate(() => window.__popup), [false, true]);
});
await check('websocket goes through the relay', async () => {
  await f.waitForFunction(() => window.__info.ws && window.__info.ws.startsWith('echo:'), null, { timeout: 8000 });
  assert.equal((await info()).ws, 'echo:hi');
});
await check('address bar and title follow the page; timing strip present', async () => {
  assert.equal(await page.inputValue('#bar-input'), UP + '/');
  assert.match(await page.title(), /Upstream App/);
  assert.match(await page.textContent('#timing'), /TTFB|upstream|load/);
});

await check('SPA pushState: location.pathname updates, bar follows, back works', async () => {
  await f.evaluate(() => window.navigateSpa('/app/route2'));
  await page.waitForTimeout(300);
  assert.equal((await info()).spaPath, '/app/route2');
  assert.equal(await page.inputValue('#bar-input'), UP + '/app/route2');
  await page.click('#back'); await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#bar-input'), UP + '/');
  assert.equal((await info()).popPath, '/');
});
await check('location.href assignment to an absolute URL stays inside the proxy', async () => {
  await f.evaluate(() => window.goAbs());
  await frame.locator('#p').filter({ hasText: 'via=assign' }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#bar-input'), UP + '/plain?via=assign');
  await page.click('#back'); await frame.locator('#h').waitFor({ timeout: 8000 });
});
await check('redirect chain is followed through the proxy and cookies apply per hop', async () => {
  await frame.locator('#redir').click();
  await frame.locator('#p').filter({ hasText: 'from=redirect' }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue('#bar-input'), UP + '/plain?from=redirect');
  await page.click('#back'); await frame.locator('#h').waitFor({ timeout: 8000 });
});
await check('form POST: body, translated Origin and Referer', async () => {
  await frame.locator('#f button').click();
  const p = frame.locator('#p');
  await p.filter({ hasText: 'posted:' }).waitFor({ timeout: 8000 });
  const t = await p.textContent();
  assert.match(t, /posted:q=hello/); assert.ok(t.includes(`origin:${UP}`), t); assert.ok(t.includes(`ref:${UP}/`), t);
});

await check('no resource escapes the proxy via shadow DOM, CSSOM, <style> text, constructed sheets, templates or SVG', async () => {
  await page.fill('#bar-input', UP + '/leaks'); await page.keyboard.press('Enter');
  await frame.locator('#host').waitFor({ timeout: 8000 });
  const g = page.frames().find((x) => x.url().includes('/p/'));
  await g.evaluate(() => { document.getElementById('a').offsetWidth; document.getElementById('c').offsetWidth; }); // force style resolution
  await page.waitForTimeout(1500);
  const names = await g.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  const escaped = names.filter((n) => n.startsWith(UPORIGIN));
  assert.deepEqual(escaped, []);
  for (const q of ['shadow', 'cssom', 'csstext', 'styletext', 'constructed', 'template', 'svguse', 'svgimage']) assert.ok(names.some((n) => n.includes(`/p/`) && n.includes(q)), 'not requested through the proxy: ' + q);
});
await page.click('#back').catch(() => {}); await page.waitForTimeout(300);
await check('media: <video> plays through the service worker with Range requests', async () => {
  test_skip: if (!clip) { console.log('       (MediaRecorder unavailable; skipped)'); break test_skip; }
  await page.fill('#bar-input', UP + '/video'); await page.keyboard.press('Enter');
  await frame.locator('#v').waitFor({ timeout: 8000 });
  const g = page.frames().find((x) => x.url().includes('/p/'));
  await g.waitForFunction(() => { const v = document.getElementById('v'); return v.currentTime > 0.4 && v.readyState >= 2; }, null, { timeout: 12000 });
  const r = await g.evaluate(async () => { const x = await fetch('/clip.webm', { headers: { Range: 'bytes=0-9' } }); return [x.status, x.headers.get('content-range'), (await x.arrayBuffer()).byteLength]; });
  assert.equal(r[0], 206); assert.match(r[1], /^bytes 0-9\//); assert.equal(r[2], 10);
});
await check('relay errors are shown as an error page inside the frame', async () => {
  await page.fill('#bar-input', 'http://127.0.0.1:1/');
  await page.keyboard.press('Enter');
  await frame.locator('text=Try again').waitFor({ timeout: 10000 });
});

await check('turning the shield off disables blocking', async () => {
  await page.click('#shield');
  await page.fill('#bar-input', UP + '/');
  await page.keyboard.press('Enter');
  await frame.locator('#h').filter({ hasText: 'ready' }).waitFor({ timeout: 15000 });
  const g = page.frames().find((x) => x.url().includes('/p/'));
  assert.equal(await g.evaluate(() => window.__info.adLoaded), true);
});

await check('server-rewrite fallback mode still works', async () => {
  await page.goto(`${SHELL}?api=http://127.0.0.1:${apiPort}`);
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ls.settings') || '{}'); s.mode = 'server'; s.adblock = true; localStorage.setItem('ls.settings', JSON.stringify(s)); });
  await page.goto(`${SHELL}?api=http://127.0.0.1:${apiPort}`);
  await page.waitForSelector('#status-pill[data-state="ok"]');
  assert.doesNotMatch(await page.textContent('#status-pill'), /Static proxy/);
  await page.fill('#home-input', UP + '/');
  await page.keyboard.press('Enter');
  await page.frameLocator('#frame').locator('#h').filter({ hasText: 'ready' }).waitFor({ timeout: 15000 });
  const g = page.frames().find((x) => x.url().includes('/p/'));
  assert.ok(g.url().startsWith(`http://127.0.0.1:${apiPort}/p/`));
  assert.equal(await g.evaluate(() => window.__info.pathname), '/');
  assert.equal(await g.evaluate(() => window.__info.adLoaded), false);
});

await page.screenshot({ path: process.env.SHOT || '/tmp/ls-browser.png' });
console.log(`\n${passed} checks passed, ${problems.length} problem(s)`);
for (const p of problems) console.log(' - ' + p);
await browser.close(); closeApi(); api.closeAllConnections?.(); upstream.closeAllConnections?.(); pages.close(); upstream.close();
process.exit(problems.length ? 1 : 0);
