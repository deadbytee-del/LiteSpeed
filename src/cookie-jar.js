/**
 * RFC 6265-style cookie jar for service-worker mode. Synthesised responses
 * cannot set browser cookies and the SW cannot read them, so cookies for proxied
 * sites live here and are persisted through a pluggable async `store`.
 */
const MAX_PER_HOST = 180;
const MAX_SIZE = 4096;

function defaultPath(pathname) {
  if (!pathname.startsWith('/')) return '/';
  const i = pathname.lastIndexOf('/');
  return i <= 0 ? '/' : pathname.slice(0, i);
}

function parse(header, url, now) {
  const parts = header.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq < 1 && !(eq === 0 && false)) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || name.length + value.length > MAX_SIZE) return null;
  const host = url.hostname.toLowerCase();
  const c = { name, value, domain: host, hostOnly: true, path: defaultPath(url.pathname), secure: false, httpOnly: false, expires: null, created: now };
  let maxAge = null;
  let expires = null;
  for (const raw of parts) {
    const i = raw.indexOf('=');
    const k = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : raw.slice(i + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      if (!d.includes('.') || !(host === d || host.endsWith('.' + d))) return null;
      c.domain = d; c.hostOnly = false;
    } else if (k === 'path' && v.startsWith('/')) c.path = v;
    else if (k === 'secure') c.secure = true;
    else if (k === 'httponly') c.httpOnly = true;
    else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t; }
  }
  if (maxAge !== null) c.expires = now + maxAge * 1000;
  else if (expires !== null) c.expires = expires;
  if (/^__secure-/i.test(name) && !(c.secure && url.protocol === 'https:')) return null;
  if (/^__host-/i.test(name) && !(c.secure && url.protocol === 'https:' && c.hostOnly && c.path === '/')) return null;
  return c;
}

const domainMatch = (c, host) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith('.' + c.domain));
const pathMatch = (c, path) => path === c.path || (path.startsWith(c.path) && (c.path.endsWith('/') || path[c.path.length] === '/'));

export class CookieJar {
  constructor({ store = null, now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.cookies = [];
    this._ready = store ? store.load().then((list) => { this.cookies = (list || []).filter((c) => !this._expired(c)); }).catch(() => {}) : Promise.resolve();
    this._saveTimer = null;
    this.onChange = null;
  }

  ready() { return this._ready; }
  _expired(c) { return c.expires !== null && c.expires <= this.now(); }

  async setFromHeaders(url, headers, { fromScript = false } = {}) {
    await this._ready;
    let changed = false;
    for (const h of headers) {
      const c = parse(h, url, this.now());
      if (!c) continue;
      if (fromScript && c.httpOnly) continue;
      const i = this.cookies.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path && x.hostOnly === c.hostOnly);
      if (i >= 0) {
        if (fromScript && this.cookies[i].httpOnly) continue; // scripts can't overwrite HttpOnly cookies
        c.created = this.cookies[i].created;
        this.cookies.splice(i, 1);
      }
      if (c.expires !== null && c.expires <= this.now()) { changed = true; continue; }
      this.cookies.push(c);
      changed = true;
      const same = this.cookies.filter((x) => x.domain === c.domain);
      if (same.length > MAX_PER_HOST) this.cookies.splice(this.cookies.indexOf(same.sort((a, b) => a.created - b.created)[0]), 1);
    }
    if (changed) this._changed(url);
  }

  _match(url) {
    const host = url.hostname.toLowerCase();
    const https = url.protocol === 'https:';
    return this.cookies
      .filter((c) => !this._expired(c) && domainMatch(c, host) && pathMatch(c, url.pathname) && (!c.secure || https))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  async header(url) {
    await this._ready;
    return this._match(url).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** What document.cookie would show: no HttpOnly cookies. */
  async scriptView(url) {
    await this._ready;
    return this._match(url).filter((c) => !c.httpOnly).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  async clear() { await this._ready; this.cookies = []; this._changed(null); }

  _changed(url) {
    this.onChange?.(url);
    if (!this.store) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.store.save(this.cookies.filter((c) => !this._expired(c))).catch(() => {}), 200);
  }
}
