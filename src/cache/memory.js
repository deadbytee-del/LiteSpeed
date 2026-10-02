/** Byte-bounded LRU for small, fresh, cacheable responses. */
export class MemoryCache {
  constructor({ maxEntries = 300, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }

  async get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) { this.#drop(key, e); return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  async set(key, entry) {
    const old = this.map.get(key);
    if (old) this.#drop(key, old);
    this.map.set(key, { ...entry, expires: Date.now() + entry.ttl * 1000 });
    this.bytes += entry.body.byteLength;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const [k, v] = this.map.entries().next().value;
      this.#drop(k, v);
    }
  }

  #drop(key, e) {
    this.map.delete(key);
    this.bytes -= e.body.byteLength;
  }

  get size() { return this.map.size; }
}
