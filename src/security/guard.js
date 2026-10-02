import { ProxyError } from '../errors.js';

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isPrivateIPv4(host) {
  const m = V4.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

export const isPrivateIp = (ip) => (ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip));

const suffixMatch = (host, list) => list.some((s) => host === s || host.endsWith('.' + s));

/**
 * Synchronous target policy. Rejects non-http(s) schemes, loopback/private
 * literals, internal-looking names, self-requests and host allow/block lists.
 * Async DNS checks (Node) are layered on via config.hostCheck.
 */
export function checkTarget(url, config, selfHost) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError(400, 'unsupported_scheme', 'Only http and https URLs can be proxied.');
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (url.username || url.password) {
    throw new ProxyError(400, 'credentials_in_url', 'URLs containing credentials are not supported.');
  }
  if (selfHost && url.host.toLowerCase() === selfHost.toLowerCase()) {
    throw new ProxyError(400, 'loop_detected', 'The proxy cannot proxy itself.');
  }
  if (config.allowedHosts.length && !suffixMatch(host, config.allowedHosts)) {
    throw new ProxyError(403, 'host_not_allowed', 'This host is not on the allow list.');
  }
  if (suffixMatch(host, config.blockedHosts)) {
    throw new ProxyError(403, 'host_blocked', 'This host is blocked by the operator.');
  }
  if (!config.allowPrivate) {
    const internalName = host === 'localhost' || /\.(localhost|local|internal|localdomain|lan|home\.arpa)$/.test(host) || (!host.includes('.') && !host.includes(':'));
    if (internalName || isPrivateIPv4(host) || (host.includes(':') && isPrivateIPv6(host))) {
      throw new ProxyError(403, 'private_target', 'Private and loopback addresses cannot be proxied.');
    }
  }
}
