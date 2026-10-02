/** In-flight cap and per-client token bucket, so overload degrades into fast 503/429s instead of timeouts. */
export class Limiter {
  constructor({ maxInflight = 0, ratePerSec = 0, burst = 0 } = {}) {
    this.maxInflight = maxInflight;
    this.rate = ratePerSec;
    this.burst = burst || Math.max(10, ratePerSec * 2);
    this.inflight = 0;
    this.buckets = new Map();
    this._sweep = ratePerSec ? setInterval(() => this._gc(), 30000).unref?.() : null;
  }

  /** @returns {{release: Function}|{rejected: 'overloaded'|'rate_limited', retryAfter: number}} */
  acquire(client) {
    if (this.maxInflight && this.inflight >= this.maxInflight) return { rejected: 'overloaded', retryAfter: 1 };
    if (this.rate) {
      const now = Date.now();
      let b = this.buckets.get(client);
      if (!b) this.buckets.set(client, (b = { tokens: this.burst, t: now }));
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.t) / 1000) * this.rate);
      b.t = now;
      if (b.tokens < 1) return { rejected: 'rate_limited', retryAfter: Math.ceil((1 - b.tokens) / this.rate) };
      b.tokens -= 1;
    }
    this.inflight++;
    let done = false;
    return { release: () => { if (!done) { done = true; this.inflight--; } } };
  }

  /** 0..1, how close the in-flight cap is. */
  get pressure() { return this.maxInflight ? this.inflight / this.maxInflight : 0; }

  _gc() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.t > 60000) this.buckets.delete(k);
  }
}
