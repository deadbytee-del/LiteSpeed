import { ProxyError } from '../errors.js';

const ascii = (s) => s.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashHost(host) {
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) h = Math.imul(h ^ host.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Transport that tunnels each request through one or more Bare v3 relays.
 * With several relays, requests for a host stick to one relay (so its upstream
 * connections stay warm) and fail over to the next when it is down or overloaded.
 */
export class BareTransport {
  constructor({ endpoints, fetch: impl = (...a) => fetch(...a), retries = 2 }) {
    this.endpoints = endpoints.map((e) => e.replace(/\/+$/, ''));
    this.fetch = impl;
    this.retries = retries;
    this.down = new Map(); // endpoint -> time until which it is considered down
  }

  _order(host) {
    const n = this.endpoints.length;
    const start = hashHost(host) % n;
    const order = Array.from({ length: n }, (_, i) => this.endpoints[(start + i) % n]);
    const now = Date.now();
    return [...order.filter((e) => (this.down.get(e) || 0) <= now), ...order.filter((e) => (this.down.get(e) || 0) > now)];
  }

  async request({ url, method, headers, body, signal }) {
    const sent = {};
    headers.forEach((v, k) => { sent[k] = v; });
    const payload = body ? await new Response(body).arrayBuffer() : undefined;
    const idempotent = method === 'GET' || method === 'HEAD';
    const order = this._order(new URL(url).host);
    let lastErr;

    for (let attempt = 0; attempt <= (idempotent ? this.retries : 0); attempt++) {
      const endpoint = order[attempt % order.length];
      try {
        const res = await this.fetch(`${endpoint}/bare/v3/`, {
          method,
          body: payload,
          signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'manual',
          headers: { 'x-bare-url': url, 'x-bare-headers': ascii(JSON.stringify(sent)) },
        });
        const status = res.headers.get('x-bare-status');
        if (status == null) {
          let err = {};
          try { err = (await res.json()).error || {}; } catch { /* not JSON */ }
          if (res.status === 503 || res.status === 429) {
            this.down.set(endpoint, Date.now() + 2000);
            lastErr = new ProxyError(res.status, err.code || 'overloaded', err.message || 'The relay is at capacity.');
            if (idempotent && attempt < this.retries) { await sleep(150 * 2 ** attempt); continue; }
          } else lastErr = new ProxyError(err.status || res.status, err.code || 'relay_error', err.message || `Relay returned HTTP ${res.status}.`, err);
          throw lastErr;
        }
        const meta = JSON.parse(res.headers.get('x-bare-headers') || '{}');
        const setCookies = [].concat(meta['set-cookie'] || []);
        delete meta['set-cookie'];
        const h = new Headers();
        for (const [k, v] of Object.entries(meta)) { try { h.set(k, Array.isArray(v) ? v.join(', ') : v); } catch { /* skip invalid */ } }
        const st = Number(status);
        return { status: st, statusText: res.headers.get('x-bare-status-text') || '', headers: h, setCookies, body: [101, 204, 205, 304].includes(st) ? null : res.body };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof ProxyError) { lastErr = err; if (!(idempotent && attempt < this.retries && (err.status === 503 || err.status === 429))) throw err; continue; }
        this.down.set(endpoint, Date.now() + 5000);
        lastErr = new ProxyError(502, 'relay_unreachable', 'The proxy relay could not be reached.');
        if (!idempotent || attempt >= this.retries) throw lastErr;
        await sleep(100 * 2 ** attempt);
      }
    }
    throw lastErr;
  }
}
