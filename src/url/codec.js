/**
 * Proxy URL scheme:  {basePath}/p/{base64url(origin)}{path}{?query}
 *
 * The upstream origin lives in the first path segment, so relative URLs resolve
 * correctly in the browser without rewriting, and cookies can be scoped per
 * upstream origin with `Path=/p/{key}/`.
 */
const SKIP = /^(?:#|data:|blob:|javascript:|mailto:|tel:|about:|sms:|wss?:)/i;

export function encodeOrigin(origin) {
  return btoa(origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeOrigin(key) {
  try {
    let b = key.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const origin = atob(b);
    return /^https?:\/\/[^/?#\s]+$/i.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

export const proxyPrefix = (basePath = '') => `${basePath}/p/`;

/** Convert an absolute upstream URL into a root-relative proxy path. */
export function toProxyPath(url, basePath = '') {
  return `${proxyPrefix(basePath)}${encodeOrigin(url.origin)}${url.pathname}${url.search}${url.hash}`;
}

/** Parse a proxy pathname into { key, origin, rest }, or null when it isn't one. */
export function parseProxyPath(pathname, basePath = '') {
  const prefix = proxyPrefix(basePath);
  if (!pathname.startsWith(prefix)) return null;
  const tail = pathname.slice(prefix.length);
  const slash = tail.indexOf('/');
  const key = slash < 0 ? tail : tail.slice(0, slash);
  const origin = decodeOrigin(key);
  if (!origin) return null;
  return { key, origin, rest: slash < 0 ? '/' : tail.slice(slash) };
}

/** Build the upstream URL for an incoming proxy request URL. */
export function resolveTarget(requestUrl, basePath = '') {
  const parsed = parseProxyPath(requestUrl.pathname, basePath);
  if (!parsed) return null;
  try {
    // String concat on purpose: `new URL('//x', origin)` would change the host.
    return { ...parsed, url: new URL(parsed.origin + parsed.rest + requestUrl.search) };
  } catch {
    return null;
  }
}

/** Reverse of toProxyPath for a full proxy URL (used for Referer/Origin translation). */
export function fromProxyUrl(value, basePath = '') {
  try {
    const u = new URL(value);
    const t = resolveTarget(u, basePath);
    return t ? t.url : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite one URL reference found in upstream content.
 * Returns the original string when it must be left alone.
 */
export function rewriteUrl(raw, base, basePath = '') {
  if (raw == null) return raw;
  const s = raw.trim();
  if (!s || SKIP.test(s)) return raw;
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  return toProxyPath(u, basePath);
}
