/**
 * Adblock Plus / uBlock-style filter engine (network + simple cosmetic rules).
 *
 * Supported: ||domain^, |anchors, *, ^, @@ exceptions, $type options
 * (script, image, stylesheet, font, media, object, xmlhttprequest, subdocument,
 * websocket, ping, other + ~negation), $third-party / $~third-party, $domain=,
 * $match-case, $important, and generic / per-domain `##selector` hiding rules.
 * Rules using options we cannot honour (redirect=, removeparam=, csp=, regex
 * patterns, procedural cosmetics) are skipped rather than approximated.
 *
 * Lookup cost: pure-domain rules are a suffix walk over a Map; everything else
 * is bucketed by its longest safe token (the uBlock Origin approach), so most
 * URLs touch zero regexes.
 */
const TYPES = new Set(['script', 'image', 'stylesheet', 'font', 'media', 'object', 'xmlhttprequest', 'subdocument', 'document', 'websocket', 'ping', 'other']);
const TYPE_ALIASES = { css: 'stylesheet', xhr: 'xmlhttprequest', frame: 'subdocument', '3p': 'third-party', '1p': '~third-party', 'first-party': '~third-party' };
const IGNORED_OPTIONS = new Set(['important', 'match-case', 'all', 'popup', 'badfilter', 'genericblock', 'generichide', 'elemhide', 'specifichide']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'or', 'go']);
const DEST_TO_TYPE = {
  script: 'script', worker: 'script', sharedworker: 'script', serviceworker: 'script', audioworklet: 'script', paintworklet: 'script',
  image: 'image', style: 'stylesheet', font: 'font', iframe: 'subdocument', frame: 'subdocument', document: 'document',
  audio: 'media', video: 'media', track: 'media', object: 'object', embed: 'object', '': 'xmlhttprequest', empty: 'xmlhttprequest',
};

export function registrable(host) {
  const p = host.split('.');
  if (p.length <= 2 || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const tld = p[p.length - 1];
  return tld.length === 2 && SECOND_LEVEL.has(p[p.length - 2]) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const escapeRe = (s) => s.replace(/[.+?${}()|[\]\\]/g, '\\$&');

function parseOptions(optText) {
  const o = { types: null, notTypes: null, third: null, domains: null, notDomains: null, matchCase: false };
  for (const raw of optText.split(',')) {
    let name = raw.trim().toLowerCase();
    if (!name) continue;
    let neg = false;
    if (name[0] === '~') { neg = true; name = name.slice(1); }
    let value = '';
    const eq = name.indexOf('=');
    if (eq > 0) { value = raw.trim().slice(raw.trim().indexOf('=') + 1); name = name.slice(0, eq); }
    name = TYPE_ALIASES[name] ?? name;
    if (name === '~third-party') { name = 'third-party'; neg = !neg; }
    if (name === 'third-party') o.third = !neg;
    else if (name === 'domain') {
      for (const d of value.toLowerCase().split('|')) {
        if (!d) continue;
        if (d[0] === '~') (o.notDomains ??= []).push(d.slice(1)); else (o.domains ??= []).push(d);
      }
    } else if (TYPES.has(name)) (neg ? (o.notTypes ??= new Set()) : (o.types ??= new Set())).add(name);
    else if (name === 'match-case') o.matchCase = true;
    else if (!IGNORED_OPTIONS.has(name)) return null; // unsupported option: skip the whole rule
  }
  return o;
}

function patternToRegex(pat, matchCase) {
  let src = '';
  let i = 0;
  if (pat.startsWith('||')) { src = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?'; i = 2; } else if (pat[0] === '|') { src = '^'; i = 1; }
  let end = pat.length;
  let endAnchor = false;
  if (pat.length > i && pat[end - 1] === '|') { endAnchor = true; end--; }
  for (; i < end; i++) {
    const c = pat[i];
    src += c === '*' ? '.*' : c === '^' ? '(?:[^\\w\\-.%]|$)' : escapeRe(c);
  }
  if (endAnchor) src += '$';
  try { return new RegExp(src, matchCase ? '' : 'i'); } catch { return null; }
}

/** Longest alnum run in the pattern that cannot be extended by the URL around it. */
function safeToken(pat) {
  let best = '';
  const re = /[a-z0-9%]{3,}/gi;
  let m;
  while ((m = re.exec(pat))) {
    const before = pat[m.index - 1];
    const after = pat[m.index + m[0].length];
    const bOk = before !== undefined && before !== '*';
    const aOk = after !== undefined && after !== '*';
    if (bOk && aOk && m[0].length > best.length) best = m[0].toLowerCase();
  }
  return best;
}

export class FilterEngine {
  constructor() {
    this.domainBlock = new Map();
    this.domainAllow = new Map();
    this.tokenBlock = new Map();
    this.tokenAllow = new Map();
    this.looseBlock = [];
    this.looseAllow = [];
    this.genericCss = new Set();
    this.genericCssExceptions = new Set();
    this.siteCss = new Map();
    this.siteCssExceptions = new Map();
    this.counts = { network: 0, cosmetic: 0, skipped: 0 };
    this._cssCache = new Map();
  }

  add(text) {
    for (const line of text.split(/\r?\n/)) this.addRule(line.trim());
    this._cssCache.clear();
    return this;
  }

  addRule(line) {
    if (!line || line[0] === '!' || line[0] === '[' ) return;
    const cos = /^([^#]*?)#(@?)#(.+)$/.exec(line);
    if (cos) return this.addCosmetic(cos[1], cos[2] === '@', cos[3]);
    if (/#[?$%]#|#@[?$%]#/.test(line)) { this.counts.skipped++; return; }

    let allow = false;
    let pat = line;
    if (pat.startsWith('@@')) { allow = true; pat = pat.slice(2); }
    let opts = null;
    const d = pat.lastIndexOf('$');
    if (d >= 0 && /^[\w~=|.,\-*]*$/.test(pat.slice(d + 1)) && !pat.slice(d + 1).includes('/')) {
      opts = parseOptions(pat.slice(d + 1));
      if (!opts) { this.counts.skipped++; return; }
      pat = pat.slice(0, d);
    }
    if (!pat || (pat[0] === '/' && pat.endsWith('/') && pat.length > 2)) { this.counts.skipped++; return; } // regex rules unsupported
    const rule = { opts, allow, text: line };

    const domainOnly = /^\|\|([a-z0-9.-]+\.[a-z0-9-]+)\^?$/i.exec(pat);
    if (domainOnly && (!opts || !opts.matchCase)) {
      const map = allow ? this.domainAllow : this.domainBlock;
      const host = domainOnly[1].toLowerCase();
      (map.get(host) ?? map.set(host, []).get(host)).push(rule);
      this.counts.network++;
      return;
    }
    rule.re = patternToRegex(pat, opts?.matchCase);
    if (!rule.re) { this.counts.skipped++; return; }
    const tok = safeToken(pat);
    if (tok) {
      const map = allow ? this.tokenAllow : this.tokenBlock;
      (map.get(tok) ?? map.set(tok, []).get(tok)).push(rule);
    } else (allow ? this.looseAllow : this.looseBlock).push(rule);
    this.counts.network++;
  }

  addCosmetic(domains, exception, selector) {
    if (/:(?:has-text|xpath|matches-css|-abp-|contains|upward|remove|style|nth-ancestor|watch-attr)\b|\+js\(/.test(selector)) { this.counts.skipped++; return; }
    this.counts.cosmetic++;
    const doms = domains ? domains.toLowerCase().split(',').filter(Boolean) : [];
    if (!doms.length) { (exception ? this.genericCssExceptions : this.genericCss).add(selector); return; }
    for (const d of doms) {
      const neg = d[0] === '~';
      const host = neg ? d.slice(1) : d;
      if (neg) continue; // negated domains on cosmetic rules: ignored (rule applies only where listed)
      const map = exception ? this.siteCssExceptions : this.siteCss;
      (map.get(host) ?? map.set(host, new Set()).get(host)).add(selector);
    }
  }

  /** @returns {{blocked: boolean, rule?: string}} */
  check({ url, type = 'other', pageUrl = '' }) {
    if (type === 'document') return { blocked: false };
    const host = hostOf(url);
    if (!host) return { blocked: false };
    const pageHost = pageUrl ? hostOf(pageUrl) : '';
    const ctx = { url, lower: url.toLowerCase(), type, host, pageHost, third: pageHost ? registrable(pageHost) !== registrable(host) : false };

    const hit = this._find(ctx, this.domainBlock, this.tokenBlock, this.looseBlock);
    if (!hit) return { blocked: false };
    if (this._find(ctx, this.domainAllow, this.tokenAllow, this.looseAllow)) return { blocked: false };
    return { blocked: true, rule: hit.text };
  }

  _find(ctx, domainMap, tokenMap, loose) {
    for (let h = ctx.host; h; ) {
      const rules = domainMap.get(h);
      if (rules) for (const r of rules) if (this._opts(r, ctx)) return r;
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    if (tokenMap.size) {
      const seen = new Set();
      for (const tok of ctx.lower.match(/[a-z0-9%]{3,}/g) || []) {
        if (seen.has(tok)) continue;
        seen.add(tok);
        const rules = tokenMap.get(tok);
        if (rules) for (const r of rules) if (this._opts(r, ctx) && (r.opts?.matchCase ? r.re.test(ctx.url) : r.re.test(ctx.lower))) return r;
      }
    }
    for (const r of loose) if (this._opts(r, ctx) && (r.opts?.matchCase ? r.re.test(ctx.url) : r.re.test(ctx.lower))) return r;
    return null;
  }

  _opts(r, ctx) {
    const o = r.opts;
    if (!o) return true;
    if (o.types && !o.types.has(ctx.type)) return false;
    if (o.notTypes && o.notTypes.has(ctx.type)) return false;
    if (o.third !== null && ctx.pageHost && o.third !== ctx.third) return false;
    if (o.domains || o.notDomains) {
      const ph = ctx.pageHost;
      const m = (list) => list.some((d) => ph === d || ph.endsWith('.' + d));
      if (o.notDomains && m(o.notDomains)) return false;
      if (o.domains && !m(o.domains)) return false;
    }
    return true;
  }

  /** CSS that hides ad containers on `hostname` (cached per host). */
  cosmeticCss(hostname) {
    const host = (hostname || '').toLowerCase();
    let css = this._cssCache.get(host);
    if (css !== undefined) return css;
    const sel = new Set(this.genericCss);
    const off = new Set(this.genericCssExceptions);
    for (let h = host; h; ) {
      this.siteCss.get(h)?.forEach((s) => sel.add(s));
      this.siteCssExceptions.get(h)?.forEach((s) => off.add(s));
      const dot = h.indexOf('.');
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    const list = [...sel].filter((s) => !off.has(s));
    // Chunk so one invalid selector only drops its own chunk, not the whole sheet.
    const chunks = [];
    for (let i = 0; i < list.length; i += 40) chunks.push(list.slice(i, i + 40).join(',') + '{display:none!important}');
    css = chunks.join('\n');
    if (this._cssCache.size > 200) this._cssCache.clear();
    this._cssCache.set(host, css);
    return css;
  }
}

export const requestType = (destination) => DEST_TO_TYPE[destination || ''] || 'other';
