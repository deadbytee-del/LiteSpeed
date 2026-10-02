import { fromProxyUrl } from '../url/codec.js';

const REQ_DROP = /^(host|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|accept-encoding|content-length|expect|sec-.*|cf-.*|cdn-loop|x-forwarded-.*|x-real-ip|x-vercel-.*|x-amzn-.*|x-envoy-.*|fly-.*|forwarded|via|true-client-ip|origin|referer|priority)$/i;

const RES_ALLOW = new Set([
  'content-type', 'content-language', 'content-disposition', 'content-range', 'accept-ranges',
  'cache-control', 'expires', 'last-modified', 'etag', 'pragma', 'vary', 'retry-after', 'age',
]);
const RES_X_DENY = /^x-(frame-options|xss-protection|content-type-options|powered-by|robots-tag)$/i;

/** Headers forwarded to the upstream server, with Referer/Origin translated back to upstream terms. */
export function buildUpstreamHeaders(request, target, config) {
  const h = new Headers();
  for (const [k, v] of request.headers) if (!REQ_DROP.test(k)) h.set(k, v);
  if (config.userAgent) h.set('user-agent', config.userAgent);

  // In a service worker the Referer header is hidden but request.referrer is available.
  const ref = request.headers.get('referer') || (request.referrer && request.referrer !== 'about:client' ? request.referrer : '');
  const refTarget = ref ? fromProxyUrl(ref, config.basePath) : null;
  if (refTarget) h.set('referer', refTarget.href);
  if (request.headers.has('origin') || (request.method !== 'GET' && request.method !== 'HEAD')) h.set('origin', refTarget ? refTarget.origin : target.origin);
  return h;
}

/** Allow-list of upstream response headers that are safe and useful to forward. */
export function filterResponseHeaders(upstream) {
  const h = new Headers();
  for (const [k, v] of upstream.headers) {
    if (RES_ALLOW.has(k) || (k.startsWith('x-') && !RES_X_DENY.test(k))) h.set(k, v);
  }
  return h;
}
