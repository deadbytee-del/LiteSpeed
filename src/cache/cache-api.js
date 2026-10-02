/** Cache backed by the Workers Cache API (shared across requests within a data centre). */
export class CacheApiCache {
  constructor(cache) { this.cache = cache; }

  #req(key) { return new Request('https://litespeed.invalid/' + encodeURIComponent(key)); }

  async get(key) {
    const res = await this.cache.match(this.#req(key));
    if (!res) return undefined;
    const meta = JSON.parse(res.headers.get('x-ls-meta') || '{}');
    return { status: meta.status, headers: meta.headers, body: new Uint8Array(await res.arrayBuffer()) };
  }

  async set(key, entry) {
    const res = new Response(entry.body, {
      headers: { 'cache-control': `max-age=${entry.ttl}`, 'x-ls-meta': JSON.stringify({ status: entry.status, headers: entry.headers }) },
    });
    await this.cache.put(this.#req(key), res);
  }
}
