import { rewriteUrl, fromProxyUrl } from '../url/codec.js';
import { rewriteSetCookies } from '../cookies.js';
import { buildUpstreamHeaders, filterResponseHeaders } from '../rewrite/headers.js';
import { anySignal } from '../transport/fetch.js';
import { ProxyError } from '../errors.js';
import { createRewriters, isWorker } from './rewriters.js';
import { requestType, blockedResponse } from '../adblock/index.js';
import { VERSION } from '../version.js';

const NO_BODY = new Set([101, 204, 205, 304]);
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);
const now = () => (globalThis.performance ? performance.now() : Date.now());

function cacheTtl(headers, config) {
  const cc = (headers.get('cache-control') || '').toLowerCase();
  if (!cc || /no-store|no-cache|private/.test(cc)) return 0;
  const vary = (headers.get('vary') || '').toLowerCase().replace(/accept-encoding/g, '').replace(/[,\s]/g, '');
  if (vary) return 0;
  const m = /s-maxage=(\d+)/.exec(cc) || /max-age=(\d+)/.exec(cc);
  return m ? Math.min(Number(m[1]), config.cacheMaxTtl) : 0;
}

/** Collect up to `limit` bytes while streaming through; call `done(bytes|null)` at the end. */
function tap(limit, done) {
  const chunks = [];
  let size = 0;
  let over = false;
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (over) return;
      size += chunk.byteLength;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    },
    flush() {
      if (over) return done(null);
      const body = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) { body.set(c, o); o += c.byteLength; }
      done(body);
    },
  });
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The request/response pipeline. It is platform-neutral: the same class runs in
 * the Node/Workers backend (server mode) and inside the service worker (sw mode).
 *
 *   transport  – how upstream is reached (direct fetch, or a Bare relay)
 *   cache      – optional response cache
 *   jar        – optional cookie jar (sw mode); without it cookies are scoped
 *                into browser cookies via Set-Cookie (server mode)
 *   adblock    – optional FilterEngine
 */
export class ProxyEngine {
  constructor({ config, transport, cache = null, jar = null, adblock = null, onBlock = null, rewriters = createRewriters(config) }) {
    this.config = config;
    this.transport = transport;
    this.cache = cache;
    this.jar = jar;
    this.adblock = adblock;
    this.onBlock = onBlock;
    this.rewriters = rewriters;
  }

  runtimeTag(cookieSnapshot) {
    const c = this.config;
    const src = c.runtimeSrc || `${c.basePath}/api/runtime.js?v=${VERSION}`;
    let tag = `<script src="${attr(src)}" data-base="${attr(c.basePath)}" data-mode="${c.mode}"`;
    if (c.api) tag += ` data-api="${attr(c.api)}"`;
    if (c.popups) tag += ' data-popups="block"';
    if (cookieSnapshot !== undefined) tag += ` data-cookie="${attr(encodeURIComponent(cookieSnapshot))}"`;
    return tag + '></script>';
  }

  /**
   * @param target {{ key: string, url: URL }}
   * @param ctx    {{ destination?: string, pageUrl?: string, waitUntil?: Function }}
   */
  async handle(request, target, ctx = {}) {
    const { config } = this;
    const t0 = now();
    const { url, key } = target;
    const method = request.method;

    // Resource type: Fetch Metadata header on the server, request.destination in a service worker.
    const hdrDest = request.headers.get('sec-fetch-dest');
    const dest = ctx.destination ?? (request.destination ? request.destination : hdrDest ?? (ctx.knownDestination ? '' : null));
    const inject = dest === null || dest === 'document' || dest === 'iframe' || dest === 'frame';

    if (this.adblock && config.adblock && dest !== 'document') {
      const pageUrl = ctx.pageUrl ?? (fromProxyUrl(request.headers.get('referer') || request.referrer || '', config.basePath)?.href || '');
      const verdict = this.adblock.check({ url: url.href, type: requestType(dest ?? 'other'), pageUrl });
      if (verdict.blocked) {
        this.onBlock?.({ url: url.href, rule: verdict.rule, type: requestType(dest ?? 'other'), pageUrl });
        return blockedResponse(dest ?? 'other', verdict.rule);
      }
    }

    const upstreamHeaders = buildUpstreamHeaders(request, url, config);
    if (this.jar) {
      const ck = await this.jar.header(url);
      if (ck) upstreamHeaders.set('cookie', ck); else upstreamHeaders.delete('cookie');
    }

    const personalised = upstreamHeaders.has('cookie') || upstreamHeaders.has('authorization');
    const cacheable = !!this.cache && config.cache && method === 'GET' && !personalised && !request.headers.has('range');
    const cacheKey = `${inject ? 1 : 0}${isWorker(dest) ? 'w' : ''}|${url.href}`;

    if (cacheable) {
      const hit = await this.cache.get(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        headers.set('x-litespeed-cache', 'HIT');
        headers.set('server-timing', `proxy;dur=${(now() - t0).toFixed(1)}, cache;desc="hit"`);
        return new Response(hit.body, { status: hit.status, headers });
      }
    }

    // Header-phase timeout only: long media/streaming bodies must not be cut off.
    const timer = new AbortController();
    const timeoutId = setTimeout(() => timer.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), config.timeoutMs);
    let up;
    const tUp = now();
    try {
      up = await this.transport.request({
        url: url.href,
        method,
        headers: upstreamHeaders,
        body: BODYLESS_METHODS.has(method) ? undefined : request.body,
        signal: anySignal([request.signal, timer.signal]),
      });
    } catch (err) {
      if (timer.signal.aborted && !request.signal?.aborted) throw new ProxyError(504, 'upstream_timeout', 'The upstream server took too long to respond.');
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
    const upstreamMs = now() - tUp;

    const headers = filterResponseHeaders(up);
    const setCookies = up.setCookies ?? (typeof up.headers.getSetCookie === 'function' ? up.headers.getSetCookie() : []);
    let cookieCount = 0;
    if (setCookies.length) {
      if (this.jar) await this.jar.setFromHeaders(url, setCookies);
      else for (const c of rewriteSetCookies(setCookies, key, config.basePath)) { headers.append('set-cookie', c); cookieCount++; }
    }

    const loc = up.headers.get('location');
    if (loc) headers.set('location', rewriteUrl(loc, url, config.basePath));

    const status = up.status;
    const hasBody = up.body && method !== 'HEAD' && !NO_BODY.has(status);
    const ct = up.headers.get('content-type') || '';
    const rewriter = hasBody && status !== 206 ? this.rewriters.find((r) => r.test(ct, { dest })) : null;
    let body = hasBody ? up.body : null;
    let timing = `upstream;dur=${upstreamMs.toFixed(1)}, proxy;dur=${(now() - t0 - upstreamMs).toFixed(1)}`;

    if (rewriter) {
      let runtimeTag = '';
      let headExtra = '';
      if (rewriter.name === 'html' && inject) {
        runtimeTag = this.runtimeTag(this.jar ? await this.jar.scriptView(url) : undefined);
        if (this.adblock && config.adblock) {
          const css = this.adblock.cosmeticCss(url.hostname);
          if (css) headExtra = `<style data-ls-adblock>${css}</style>`;
        }
      }
      body = body.pipeThrough(rewriter.create({ base: url, basePath: config.basePath, inject, runtimeTag, headExtra, contentType: ct, destination: dest }));
      for (const h of ['content-length', 'etag', 'last-modified', 'content-range', 'accept-ranges']) headers.delete(h);
      headers.set('content-type', rewriter.contentType(ct));
      timing += `, rewrite;desc="${rewriter.name}"`;
    } else {
      const cl = up.headers.get('content-length');
      if (cl && !up.headers.get('content-encoding') && (hasBody || method === 'HEAD')) headers.set('content-length', cl);
    }

    headers.set('x-litespeed-target', url.href);
    headers.set('server-timing', timing);

    const ttl = cacheable && status === 200 && hasBody && !cookieCount && !setCookies.length ? cacheTtl(up.headers, config) : 0;
    if (ttl > 0) {
      headers.set('x-litespeed-cache', 'MISS');
      const snapshot = [...headers].filter(([k]) => k !== 'x-litespeed-cache' && k !== 'server-timing');
      body = body.pipeThrough(
        tap(config.cacheMaxItemBytes, (bytes) => {
          if (!bytes) return;
          const p = this.cache.set(cacheKey, { status, headers: snapshot, body: bytes, ttl }).catch(() => {});
          ctx.waitUntil?.(p);
        }),
      );
    } else {
      headers.set('x-litespeed-cache', 'BYPASS');
    }

    return new Response(body, { status, headers });
  }
}
