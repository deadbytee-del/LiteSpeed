import { ProxyError } from './errors.js';
import { VERSION } from './version.js';
import { anySignal } from './transport/fetch.js';

/**
 * Bare v3-compatible relay (https://github.com/tomphttp/specifications).
 * The client (a service worker) sends the real destination in X-Bare-* headers;
 * the relay performs the request without following redirects and returns the
 * remote status, headers and body. It does no rewriting at all, which keeps it
 * cheap and lets the browser carry the rewriting load.
 */
const ascii = (s) => s.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const HOP = /^(connection|keep-alive|transfer-encoding|upgrade|proxy-.*|te|trailer)$/i;
const DROP_REQ = /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|sec-.*|cf-.*|x-forwarded-.*|x-bare-.*)$/i;

export function manifest() {
  return {
    versions: ['v3'],
    language: 'JS',
    memoryUsage: Math.round((globalThis.process?.memoryUsage?.().heapUsed ?? 0) / 1e4) / 100,
    project: { name: 'LiteSpeed', description: 'Lightweight web proxy relay', version: VERSION },
  };
}

export async function bareV3(request, { transport, guard, timeoutMs }) {
  const raw = request.headers.get('x-bare-url');
  if (!raw) throw new ProxyError(400, 'MISSING_BARE_HEADER', 'Missing X-Bare-URL header.');
  let url;
  try { url = new URL(raw); } catch { throw new ProxyError(400, 'INVALID_BARE_HEADER', 'X-Bare-URL is not a valid URL.'); }
  await guard(url);

  let sent;
  try { sent = JSON.parse(request.headers.get('x-bare-headers') || '{}'); } catch { throw new ProxyError(400, 'INVALID_BARE_HEADER', 'X-Bare-Headers is not valid JSON.'); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(sent)) {
    if (DROP_REQ.test(k)) continue;
    try { headers.set(k, Array.isArray(v) ? v.join(', ') : String(v)); } catch { /* skip invalid header */ }
  }
  for (const name of (request.headers.get('x-bare-forward-headers') || '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n && !DROP_REQ.test(n) && request.headers.has(n)) headers.set(n, request.headers.get(n));
  }

  const method = request.method;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
  let up;
  try {
    up = await transport.request({
      url: url.href, method, headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
      signal: anySignal([request.signal, ac.signal]),
    });
  } catch (err) {
    if (ac.signal.aborted && !request.signal?.aborted) throw new ProxyError(504, 'upstream_timeout', 'The upstream server took too long to respond.');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const remote = {};
  for (const [k, v] of up.headers) {
    if (k === 'set-cookie' || k === 'content-encoding' || HOP.test(k)) continue;
    if (k === 'content-length' && up.headers.get('content-encoding')) continue;
    remote[k] = v;
  }
  const cookies = up.setCookies ?? (typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : []);
  if (cookies.length) remote['set-cookie'] = cookies;

  const out = new Headers({
    'x-bare-status': String(up.status),
    'x-bare-status-text': ascii(up.statusText || ''),
    'x-bare-headers': ascii(JSON.stringify(remote)),
    'cache-control': 'no-store',
  });
  const cl = remote['content-length'];
  if (cl) out.set('content-length', cl);
  for (const name of (request.headers.get('x-bare-pass-headers') || '').split(',')) {
    const n = name.trim().toLowerCase();
    if (n && up.headers.has(n) && n !== 'set-cookie') out.set(n, up.headers.get(n));
  }
  const pass = (request.headers.get('x-bare-pass-status') || '').split(',').map((s) => s.trim());
  const status = pass.includes(String(up.status)) ? up.status : 200;
  const noBody = method === 'HEAD' || [101, 204, 205, 304].includes(up.status) || status === 304;
  return new Response(noBody ? null : up.body, { status, headers: out });
}
