import { rewriteUrl } from '../url/codec.js';
import { rewriteSetCookies } from '../cookies.js';
import { buildUpstreamHeaders, filterResponseHeaders } from '../rewrite/headers.js';
import { anySignal } from '../transport/fetch.js';
import { ProxyError } from '../errors.js';
import { createRewriters } from './rewriters.js';
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

function wantsRuntime(request) {
  const dest = request.headers.get('sec-fetch-dest');
  return !dest || dest === 'document' || dest === 'iframe' || dest === 'frame';
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

export class ProxyEngine {
  constructor({ config, transport, cache = null, rewriters = createRewriters(config) }) {
    this.config = config;
    this.transport = transport;
    this.cache = cache;
    this.rewriters = rewriters;
  }

  /** @param target {{ key: string, url: URL }} */
  async handle(request, target, ctx) {
    const { config } = this;
    const t0 = now();
    const { url, key } = target;
    const method = request.method;
    const inject = wantsRuntime(request);
    const personalised = request.headers.has('cookie') || request.headers.has('authorization');
    const cacheable = !!this.cache && config.cache && method === 'GET' && !personalised && !request.headers.has('range');
    const cacheKey = `${inject ? 1 : 0}|${url.href}`;

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
        headers: buildUpstreamHeaders(request, url, config),
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
    const cookies = rewriteSetCookies(up.headers, key, config.basePath);
    for (const c of cookies) headers.append('set-cookie', c);

    const loc = up.headers.get('location');
    if (loc) headers.set('location', rewriteUrl(loc, url, config.basePath));

    const status = up.status;
    const hasBody = up.body && method !== 'HEAD' && !NO_BODY.has(status);
    const ct = up.headers.get('content-type') || '';
    const rewriter = hasBody && status !== 206 ? this.rewriters.find((r) => r.test(ct)) : null;
    let body = hasBody ? up.body : null;
    let timing = `upstream;dur=${upstreamMs.toFixed(1)}, proxy;dur=${(now() - t0 - upstreamMs).toFixed(1)}`;

    if (rewriter) {
      body = body.pipeThrough(
        rewriter.create({
          base: url,
          basePath: config.basePath,
          runtimeSrc: `${config.basePath}/api/runtime.js?v=${VERSION}`,
          inject,
          contentType: ct,
        }),
      );
      for (const h of ['content-length', 'etag', 'last-modified', 'content-range', 'accept-ranges']) headers.delete(h);
      headers.set('content-type', rewriter.contentType(ct));
      timing += `, rewrite;desc="${rewriter.name}"`;
    } else {
      const cl = up.headers.get('content-length');
      if (cl && !up.headers.get('content-encoding') && hasBody) headers.set('content-length', cl);
      if (!hasBody && method === 'HEAD' && cl && !up.headers.get('content-encoding')) headers.set('content-length', cl);
    }

    headers.set('x-litespeed-target', url.href);
    headers.set('server-timing', timing);

    const ttl = cacheable && status === 200 && hasBody && !cookies.length ? cacheTtl(up.headers, config) : 0;
    if (ttl > 0) {
      headers.set('x-litespeed-cache', 'MISS');
      const snapshot = [...headers].filter(([k]) => k !== 'x-litespeed-cache' && k !== 'server-timing');
      body = body.pipeThrough(
        tap(config.cacheMaxItemBytes, (bytes) => {
          if (!bytes) return;
          const p = this.cache.set(cacheKey, { status, headers: snapshot, body: bytes, ttl }).catch(() => {});
          ctx?.waitUntil?.(p);
        }),
      );
    } else {
      headers.set('x-litespeed-cache', 'BYPASS');
    }

    return new Response(body, { status, headers });
  }
}
