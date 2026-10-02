// Address handling. encodeOrigin/proxyUrl mirror src/url/codec.js on the backend.
export const SEARCH_ENGINES = {
  ddg: ['DuckDuckGo', 'https://html.duckduckgo.com/html/?q=%s'],
  brave: ['Brave Search', 'https://search.brave.com/search?q=%s'],
  bing: ['Bing', 'https://www.bing.com/search?q=%s'],
  wiki: ['Wikipedia', 'https://en.wikipedia.org/w/index.php?search=%s'],
};

export const DEMO_PAGES = { demo: 'index', article: 'article', rewriting: 'rewriting', error: 'error' };

export function encodeOrigin(origin) {
  return btoa(origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function proxyUrl(api, target) {
  const u = new URL(target);
  return `${api}/p/${encodeOrigin(u.origin)}${u.pathname}${u.search}${u.hash}`;
}

/** Turn whatever the user typed into { kind: 'url' | 'search' | 'demo', ... } */
export function normalizeInput(text, settings) {
  const s = text.trim();
  if (!s) return null;
  const demo = /^litespeed:\/\/([\w-]*)/i.exec(s);
  if (demo) return { kind: 'demo', page: DEMO_PAGES[demo[1].toLowerCase()] ? demo[1].toLowerCase() : 'demo' };
  if (/^https?:\/\//i.test(s)) return tryUrl(s) || search(s, settings);
  if (!/\s/.test(s) && (/^[^\s/]+\.[a-z]{2,}([:/?#]|$)/i.test(s) || /^[^\s/]+:\d{2,5}([/?#]|$)/.test(s) || /^localhost([:/?#]|$)/i.test(s))) {
    return tryUrl('https://' + s) || search(s, settings);
  }
  return search(s, settings);
}

function tryUrl(s) {
  try { const u = new URL(s); return u.hostname ? { kind: 'url', url: u.href } : null; } catch { return null; }
}

function search(q, settings) {
  const tpl = settings.search === 'custom' && settings.searchCustom.includes('%s') ? settings.searchCustom : (SEARCH_ENGINES[settings.search] || SEARCH_ENGINES.ddg)[1];
  return { kind: 'search', url: tpl.replace('%s', encodeURIComponent(q)), query: q };
}

export const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
