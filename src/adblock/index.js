import { FilterEngine, requestType } from './engine.js';
import { DEFAULT_LIST } from './default-list.js';

export { FilterEngine, requestType, registrable } from './engine.js';
export { DEFAULT_LIST } from './default-list.js';

// 1x1 transparent GIF, so blocked <img> elements collapse quietly.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));

export function createAdblock({ lists = [] } = {}) {
  const engine = new FilterEngine().add(DEFAULT_LIST);
  for (const l of lists) engine.add(l);
  return engine;
}

/** A neutral stand-in response for a blocked request, shaped to its resource type. */
export function blockedResponse(destination, rule) {
  const h = { 'x-litespeed-blocked': encodeURIComponent(rule || 'adblock'), 'cache-control': 'no-store' };
  switch (requestType(destination)) {
    case 'script': return new Response('/* blocked by LiteSpeed */', { status: 200, headers: { ...h, 'content-type': 'text/javascript' } });
    case 'stylesheet': return new Response('/* blocked by LiteSpeed */', { status: 200, headers: { ...h, 'content-type': 'text/css' } });
    case 'image': return new Response(GIF, { status: 200, headers: { ...h, 'content-type': 'image/gif' } });
    case 'subdocument': return new Response('<!doctype html><title></title>', { status: 200, headers: { ...h, 'content-type': 'text/html' } });
    default: return new Response(null, { status: 204, headers: h });
  }
}
