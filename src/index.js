import { loadConfig } from './config.js';
import { ProxyError, classifyFetchError } from './errors.js';
import { VERSION } from './version.js';
import { resolveTarget, parseProxyPath, toProxyPath } from './url/codec.js';
import { checkTarget } from './security/guard.js';
import { FetchTransport, anySignal } from './transport/fetch.js';
import { MemoryCache } from './cache/memory.js';
import { ProxyEngine } from './engine/proxy-engine.js';
import { RUNTIME_SOURCE } from './runtime/client.js';
import { errorPage } from './pages.js';

const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ENDPOINTS = [
  ['GET', '/api/health', 'Liveness and runtime information'],
  ['GET', '/api/info', 'Capabilities and limits'],
  ['GET', '/api/resolve?url=', 'Normalise an address and return its proxy URL'],
  ['GET', '/api/go?url=', 'Redirect to the proxied page'],
  ['GET', '/api/ping?url=', 'Measure server-to-upstream latency'],
  ['GET', '/api/runtime.js', 'Client runtime injected into proxied pages'],
  ['ANY', '/p/{key}/{path}', 'Proxy a resource ({key} = base64url of the upstream origin)'],
];

/**
 * Create the LiteSpeed application: a pure `fetch(Request) -> Response` handler
 * with no platform dependencies, so it runs unchanged on Node, Workers and Deno.
 */
export function createApp({ env = {}, config: overrides, runtime = 'unknown', transport, cache, engine, hostCheck } = {}) {
  const config = loadConfig(env, overrides);
  const bp = config.basePath;
  const started = Date.now();
  const theCache = cache === undefined ? (config.cache ? new MemoryCache({ maxEntries: config.cacheMaxEntries, maxBytes: config.cacheMaxBytes }) : null) : cache;
  const theEngine = engine || new ProxyEngine({ config, transport: transport || new FetchTransport(), cache: theCache });
  const theTransport = theEngine.transport;

  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

  function cors(request, res) {
    const headers = new Headers(res.headers);
    const origin = request.headers.get('origin');
    const list = config.allowedOrigins;
    if (list.includes('*')) headers.set('access-control-allow-origin', '*');
    else if (origin && list.includes(origin.toLowerCase().replace(/\/$/, ''))) {
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-credentials', 'true');
      headers.append('vary', 'origin');
    }
    headers.set('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('access-control-allow-headers', request.headers.get('access-control-request-headers') || '*');
    headers.set('access-control-expose-headers', 'server-timing, x-litespeed-cache, x-litespeed-target, content-length');
    headers.set('access-control-max-age', '86400');
    headers.set('timing-allow-origin', '*');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  function errorResponse(err, request, target) {
    const e = classifyFetchError(err);
    if (e.status >= 500 && !(err instanceof ProxyError)) console.error('[litespeed]', err);
    const accept = request.headers.get('accept') || '';
    const dest = request.headers.get('sec-fetch-dest');
    const html = accept.includes('text/html') && (!dest || dest === 'document' || dest === 'iframe');
    const payload = { status: e.status, code: e.code, message: e.message };
    if (html) {
      return new Response(errorPage({ ...payload, target: target?.href }), {
        status: e.status === 499 ? 400 : e.status,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return json({ error: { ...payload, ...(target ? { target: target.href } : {}) } }, e.status === 499 ? 400 : e.status);
  }

  function parseInput(raw) {
    if (!raw) throw new ProxyError(400, 'missing_url', 'The "url" query parameter is required.');
    let s = raw.trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^/]*:\d+(\/|$)/.test(s)) s = 'https://' + s;
    try { return new URL(s); } catch { throw new ProxyError(400, 'invalid_url', 'That is not a valid URL.'); }
  }

  async function guarded(url, selfHost) {
    checkTarget(url, config, selfHost);
    if (hostCheck && !config.allowPrivate) await hostCheck(url.hostname);
  }

  async function apiRoute(path, request, url, ctx) {
    const selfHost = url.host;
    switch (path) {
      case '/api':
      case '/api/':
        return json({ name: 'LiteSpeed', version: VERSION, docs: 'See /api documentation page', endpoints: ENDPOINTS.map(([method, p, description]) => ({ method, path: bp + p, description })) });
      case '/api/health':
        return json({ status: 'ok', name: 'litespeed', version: VERSION, runtime, time: new Date().toISOString(), uptimeMs: Date.now() - started });
      case '/api/info':
        return json({
          name: 'litespeed', version: VERSION, runtime, basePath: bp,
          features: { streaming: true, cookies: 'per-origin path-scoped', cache: !!theCache && config.cache, rewriteJs: config.rewriteJs, websockets: false, serviceWorkers: false },
          limits: { upstreamHeaderTimeoutMs: config.timeoutMs, cacheMaxItemBytes: config.cacheMaxItemBytes, cacheMaxTtlSeconds: config.cacheMaxTtl },
          corsOrigins: config.allowedOrigins.includes('*') ? ['*'] : config.allowedOrigins,
        });
      case '/api/resolve': {
        const target = parseInput(url.searchParams.get('url'));
        await guarded(target, selfHost);
        const proxyPath = toProxyPath(target, bp);
        return json({ input: url.searchParams.get('url'), url: target.href, proxyPath, proxyUrl: url.origin + proxyPath });
      }
      case '/api/go': {
        const target = parseInput(url.searchParams.get('url'));
        await guarded(target, selfHost);
        return new Response(null, { status: 302, headers: { location: toProxyPath(target, bp), 'cache-control': 'no-store' } });
      }
      case '/api/ping': {
        const target = parseInput(url.searchParams.get('url'));
        await guarded(target, selfHost);
        const t = performance.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), config.timeoutMs);
        try {
          let res = await theTransport.request({ url: target.href, method: 'HEAD', headers: new Headers({ 'user-agent': request.headers.get('user-agent') || 'LiteSpeed' }), signal: anySignal([request.signal, ac.signal]) });
          if (res.status === 405 || res.status === 501) {
            res.body?.cancel();
            res = await theTransport.request({ url: target.href, method: 'GET', headers: new Headers({ range: 'bytes=0-0' }), signal: anySignal([request.signal, ac.signal]) });
          }
          res.body?.cancel();
          return json({ url: target.href, status: res.status, ok: res.status < 400, upstreamMs: Math.round((performance.now() - t) * 10) / 10 });
        } finally {
          clearTimeout(timer);
        }
      }
      case '/api/runtime.js':
        return new Response(RUNTIME_SOURCE, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
      default:
        return null;
    }
  }

  async function route(request, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
      return new Response(null, { status: 204 });
    }

    if (!bp || pathname.startsWith(bp + '/') || pathname === bp) {
      const local = pathname.slice(bp.length) || '/';
      if (local === '/api' || local.startsWith('/api/')) {
        const res = await apiRoute(local.replace(/\/$/, '') || '/api', request, url, ctx);
        if (res) return res;
        throw new ProxyError(404, 'not_found', 'Unknown API endpoint.');
      }
    }

    const target = resolveTarget(url, bp);
    if (target) {
      if (!PROXY_METHODS.has(request.method)) throw new ProxyError(405, 'method_not_allowed', 'Method not allowed.');
      try {
        await guarded(target.url, url.host);
        return await theEngine.handle(request, target, ctx);
      } catch (err) {
        return errorResponse(err, request, target.url);
      }
    }

    // Root-relative URLs that escaped rewriting: recover the upstream from the Referer.
    const ref = request.headers.get('referer');
    if (ref) {
      try {
        const r = new URL(ref);
        const p = r.host === url.host ? parseProxyPath(r.pathname, bp) : null;
        if (p) return new Response(null, { status: 307, headers: { location: `${bp}/p/${p.key}${pathname}${url.search}`, 'cache-control': 'no-store' } });
      } catch { /* fall through */ }
    }
    throw new ProxyError(404, 'not_found', 'Nothing here. Proxied pages live under /p/{key}/…');
  }

  return {
    config,
    engine: theEngine,
    async fetch(request, _env, ctx) {
      let res;
      try { res = await route(request, ctx); } catch (err) { res = errorResponse(err, request); }
      return cors(request, res);
    },
  };
}
