import { classifyFetchError } from '../errors.js';

/**
 * Transport contract: `request({ url, method, headers, body, signal }) -> Response`.
 * It must not follow redirects. Swap this class to tunnel through another
 * mechanism (e.g. a Node http agent with a dispatcher, or a different relay).
 */
export class FetchTransport {
  constructor({ fetch: impl = globalThis.fetch.bind(globalThis) } = {}) {
    this.fetch = impl;
  }

  async request({ url, method, headers, body, signal }) {
    const init = { method, headers, redirect: 'manual', signal };
    if (body) { init.body = body; init.duplex = 'half'; }
    try {
      return await this.fetch(url, init);
    } catch (err) {
      throw classifyFetchError(err);
    }
  }
}

export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
