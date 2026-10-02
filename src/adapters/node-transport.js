import dns from 'node:dns';
import net from 'node:net';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { ProxyError, classifyFetchError } from '../errors.js';
import { isPrivateIp } from '../security/guard.js';

/**
 * Upstream transport for Node: a pooled undici Agent (keep-alive, HTTP/2 where
 * offered) with a DNS cache and a connect-time address check. Checking the
 * address that is actually dialled closes the DNS-rebinding gap that a separate
 * pre-flight lookup would leave open.
 */
export function createGuardedLookup({ allowPrivate = false, ttlMs = 60000, maxEntries = 2000 } = {}) {
  const cache = new Map();
  return function lookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const finish = (addrs) => {
      if (!allowPrivate && addrs.some((a) => isPrivateIp(a.address))) {
        const err = Object.assign(new Error('private address'), { code: 'ERR_PRIVATE_TARGET' });
        return cb(err);
      }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    };
    if (net.isIP(hostname)) return finish([{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }]);
    const hit = cache.get(hostname);
    if (hit && hit.expires > Date.now()) return finish(hit.addrs);
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(hostname, { addrs, expires: Date.now() + ttlMs });
      finish(addrs);
    });
  };
}

export class NodeTransport {
  /**
   * @param upstreamProxy optional http(s) proxy URL for all outbound traffic (egress proxies, corporate networks).
   *   With a proxy the proxy resolves and dials the target, so the connect-time address check does not apply;
   *   the hostname policy in security/guard.js still does.
   */
  constructor({ allowPrivate = false, connections = 128, upstreamProxy = '' } = {}) {
    this.agent = upstreamProxy
      ? new ProxyAgent({ uri: upstreamProxy, connections, keepAliveTimeout: 30000, keepAliveMaxTimeout: 120000 })
      : new Agent({
        connections,
        pipelining: 1,
        keepAliveTimeout: 30000,
        keepAliveMaxTimeout: 120000,
        allowH2: true,
        connect: { lookup: createGuardedLookup({ allowPrivate }), timeout: 10000 },
      });
  }

  async request({ url, method, headers, body, signal }) {
    const init = { method, headers, redirect: 'manual', signal, dispatcher: this.agent };
    if (body) { init.body = body; init.duplex = 'half'; }
    try {
      return await undiciFetch(url, init);
    } catch (err) {
      const code = err?.cause?.code;
      if (code === 'ERR_PRIVATE_TARGET') {
        throw new ProxyError(403, 'private_target', 'This host resolves to a private address.');
      }
      throw classifyFetchError(err);
    }
  }

  close() { return this.agent.close(); }
}
