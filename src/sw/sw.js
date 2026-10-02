/* LiteSpeed service worker: the same ProxyEngine as the server, running in the browser. */
import { loadConfig } from '../config.js';
import { ProxyEngine } from '../engine/proxy-engine.js';
import { CacheApiCache } from '../cache/cache-api.js';
import { CookieJar } from '../cookie-jar.js';
import { FilterEngine, DEFAULT_LIST } from '../adblock/index.js';
import { RUNTIME_SOURCE } from '../runtime/client.js';
import { resolveTarget, parseProxyPath, fromProxyUrl } from '../url/codec.js';
import { ProxyError, classifyFetchError } from '../errors.js';
import { errorPage } from '../pages.js';
import { VERSION } from '../version.js';
import { BareTransport } from './bare-transport.js';
import { kv } from './idb.js';

const db = kv();
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const RUNTIME_PATH = `${BASE}/ls-runtime.js`;
const bc = 'BroadcastChannel' in self ? new BroadcastChannel('litespeed-cookies') : null;

const DEFAULTS = { apis: [], adblock: true, popups: true, lists: [] };
let statePromise = null;

const jar = new CookieJar({ store: { load: async () => (await db.get('jar')) || [], save: (c) => db.set('jar', c) } });
jar.onChange = () => bc?.postMessage('changed');

let blockedPending = 0;
let blockedTimer = 0;
function noteBlock() {
  blockedPending++;
  if (blockedTimer) return;
  blockedTimer = setTimeout(async () => {
    const n = blockedPending; blockedPending = 0; blockedTimer = 0;
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ ls: 'blocked', n });
  }, 120);
}

async function build() {
  const saved = { ...DEFAULTS, ...((await db.get('config')) || {}) };
  const filters = new FilterEngine().add(DEFAULT_LIST);
  for (const url of saved.lists) { const text = await db.get('list:' + url); if (text) filters.add(text); }
  const config = loadConfig({}, {
    basePath: BASE, mode: 'sw', runtimeSrc: `${RUNTIME_PATH}?v=${VERSION}`, api: saved.apis[0] || '',
    adblock: saved.adblock, popups: saved.popups, userAgent: self.navigator.userAgent, timeoutMs: 30000, rewriteJs: true,
  });
  const transport = saved.apis.length ? new BareTransport({ endpoints: saved.apis }) : null;
  const cache = new CacheApiCache(await caches.open('litespeed-v1'));
  const engine = new ProxyEngine({ config, transport, cache, jar, adblock: filters, onBlock: noteBlock });
  return { saved, engine, config, transport };
}
const getState = () => (statePromise ??= build());

/** Download extra filter lists (e.g. EasyList) through the relay and keep them for later sessions. */
async function refreshLists(lists, transport) {
  const out = [];
  for (const url of lists) {
    try {
      const res = await transport.request({ url, method: 'GET', headers: new Headers({ accept: 'text/plain' }) });
      const text = await new Response(res.body).text();
      if (res.status === 200 && text.length > 100) { await db.set('list:' + url, text); out.push({ url, rules: text.split('\n').length, ok: true }); } else out.push({ url, ok: false, error: `HTTP ${res.status}` });
    } catch (e) { out.push({ url, ok: false, error: e.message }); }
  }
  return out;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d || !d.ls) return;
  const reply = (v) => event.ports[0]?.postMessage(v);
  event.waitUntil((async () => {
    switch (d.ls) {
      case 'config': {
        await db.set('config', { ...DEFAULTS, ...d.config });
        statePromise = null;
        const st = await getState();
        let lists = [];
        if (d.refreshLists && st.transport && st.saved.lists.length) {
          lists = await refreshLists(st.saved.lists, st.transport);
          statePromise = null; await getState();
        }
        reply({ ok: true, version: VERSION, lists });
        break;
      }
      case 'cookie-get': reply(await jar.scriptView(new URL(d.url))); break;
      case 'cookie-set': await jar.setFromHeaders(new URL(d.url), [d.cookie], { fromScript: true }); break;
      case 'clear-cookies': await jar.clear(); reply({ ok: true }); break;
      case 'ping': reply({ ok: true, version: VERSION }); break;
    }
  })());
});

async function pageUrlOf(event) {
  try {
    if (event.clientId) {
      const c = await self.clients.get(event.clientId);
      const t = c && fromProxyUrl(c.url, BASE);
      if (t) return t.href;
    }
  } catch { /* fall through */ }
  const t = fromProxyUrl(event.request.referrer || '', BASE);
  return t ? t.href : '';
}

async function handleProxy(event, url) {
  const target = resolveTarget(url, BASE);
  const req = event.request;
  const wantsHtml = req.mode === 'navigate' || req.destination === 'document' || req.destination === 'iframe';
  const fail = (err, tgt) => {
    const e = classifyFetchError(err);
    const status = e.status === 499 ? 400 : e.status;
    return wantsHtml
      ? new Response(errorPage({ status, code: e.code, message: e.message, target: tgt?.href }), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      : new Response(JSON.stringify({ error: { status, code: e.code, message: e.message } }), { status, headers: { 'content-type': 'application/json' } });
  };
  if (!target) return fail(new ProxyError(400, 'invalid_url', 'Invalid proxy URL.'), null);
  try {
    const st = await getState();
    if (!st.transport) {
      return fail(new ProxyError(503, 'no_backend', 'No proxy backend is configured. Open the LiteSpeed home page and connect one.'), target.url);
    }
    await jar.ready();
    return await st.engine.handle(req, target, { knownDestination: true, pageUrl: await pageUrlOf(event), waitUntil: (p) => event.waitUntil(p) });
  } catch (err) {
    return fail(err, target.url);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === RUNTIME_PATH) {
    event.respondWith(new Response(RUNTIME_SOURCE, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } }));
    return;
  }
  if (url.pathname.startsWith(`${BASE}/p/`)) {
    // A path that starts with the prefix but carries no valid origin key is not ours to proxy.
    if (parseProxyPath(url.pathname, BASE)) { event.respondWith(handleProxy(event, url)); return; }
    return;
  }

  // A proxied page asked for a root-relative URL that escaped rewriting: send it to the right upstream.
  if (req.mode !== 'navigate') {
    event.respondWith((async () => {
      try {
        let key = null;
        if (event.clientId) { const c = await self.clients.get(event.clientId); const p = c && parseProxyPath(new URL(c.url).pathname, BASE); if (p) key = p.key; }
        if (!key) { const r = req.referrer && new URL(req.referrer); const p = r && r.origin === url.origin && parseProxyPath(r.pathname, BASE); if (p) key = p.key; }
        if (key) return Response.redirect(`${BASE}/p/${key}${url.pathname}${url.search}`, 307);
      } catch { /* fall through to the network */ }
      return fetch(req);
    })());
  }
});
