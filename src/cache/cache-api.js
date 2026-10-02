/**
 * Cache backed by the Cache API: Workers' shared edge cache, or the browser's
 * CacheStorage inside the service worker. Browsers ignore Cache-Control on
 * match(), so expiry is stored and enforced here, with a size bound.
 */
export class CacheApiCache {
  constructor(cache, { maxEntries = 400 } = {}) { this.cache = cache; this.maxEntries = maxEntries; this.writes = 0; }

  #req(key) { return new Request('https://litespeed.invalid/' + encodeURIComponent(key)); }

  async get(key) {
    const res = await this.cache.match(this.#req(key));
    if (!res) return undefined;
    const meta = JSON.parse(res.headers.get('x-ls-meta') || '{}');
    if (meta.expires && meta.expires < Date.now()) { this.cache.delete(this.#req(key)).catch(() => {}); return undefined; }
    return { status: meta.status, headers: meta.headers, body: new Uint8Array(await res.arrayBuffer()) };
  }

  async set(key, entry) {
    const res = new Response(entry.body, {
      headers: { 'cache-control': `max-age=${entry.ttl}`, 'x-ls-meta': JSON.stringify({ status: entry.status, headers: entry.headers, expires: Date.now() + entry.ttl * 1000 }) },
    });
    await this.cache.put(this.#req(key), res);
    if (++this.writes % 25 === 0) this.#trim();
  }

  async #trim() {
    try {
      const keys = await this.cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - this.maxEntries))) await this.cache.delete(k);
    } catch { /* best effort */ }
  }
}
