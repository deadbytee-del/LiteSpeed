import { proxyPrefix } from './url/codec.js';

/**
 * Upstream cookies are stored in the browser on the proxy origin, scoped to the
 * upstream origin's path prefix. No server-side session state is needed, which
 * keeps the backend stateless and edge-friendly.
 */
export function rewriteSetCookie(header, key, basePath = '') {
  const parts = header.split(';');
  const first = parts.shift().trim();
  const eq = first.indexOf('=');
  if (eq < 1) return null;
  // __Host- cookies must have Path=/, which would leak across upstream origins.
  if (/^__host-/i.test(first)) return null;
  const out = [first];
  for (const raw of parts) {
    const attr = raw.trim();
    const name = attr.split('=')[0].toLowerCase();
    if (name === 'expires' || name === 'max-age' || name === 'httponly') out.push(attr);
  }
  out.push(`Path=${proxyPrefix(basePath)}${key}/`, 'Secure', 'SameSite=None', 'Partitioned');
  return out.join('; ');
}

export function rewriteSetCookies(headers, key, basePath = '') {
  const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return list.map((c) => rewriteSetCookie(c, key, basePath)).filter(Boolean);
}
