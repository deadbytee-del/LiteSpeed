// Client runtime injected into proxied HTML documents.
// Kept as a plain string so it bundles on every platform (no fs access needed).
// Constraint: this source must not contain backticks or dollar-brace sequences.
export const RUNTIME_SOURCE = String.raw`(function () {
  'use strict';
  if (window.__litespeed) return;
  var script = document.currentScript;
  if (!script || !script.src) return;
  var DS = script.dataset || {};
  var BP = DS.base != null ? DS.base : new URL(script.src, location.href).pathname.replace(/\/api\/runtime\.js$/, '');
  var MODE = DS.mode || 'server';
  var API = DS.api || '';
  var PREFIX = BP + '/p/';
  var ORIGIN = location.origin;
  var realLocation = window.location;

  function b64d(k) { k = k.replace(/-/g, '+').replace(/_/g, '/'); while (k.length % 4) k += '='; return atob(k); }
  function b64e(s) { return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function parseProxy(u) {
    if (u.origin !== ORIGIN || u.pathname.indexOf(PREFIX) !== 0) return null;
    var rest = u.pathname.slice(PREFIX.length), i = rest.indexOf('/');
    var key = i < 0 ? rest : rest.slice(0, i), o;
    try { o = b64d(key); } catch (e) { return null; }
    if (!/^https?:\/\/[^\/?#\s]+$/i.test(o)) return null;
    return { key: key, origin: o, url: o + (i < 0 ? '/' : rest.slice(i)) + u.search + u.hash };
  }
  var here = parseProxy(new URL(location.href));
  if (!here) return;
  window.__litespeed = { version: 2, mode: MODE };

  function upstreamBase() {
    var p = parseProxy(new URL(document.baseURI));
    return p ? p.url : parseProxy(new URL(location.href)).url;
  }
  var SKIP = /^(#|data:|blob:|javascript:|mailto:|tel:|about:|sms:|wss?:)/i;

  // Map any URL the page produces onto the proxy. Idempotent.
  function rw(v) {
    if (v == null) return v;
    var t = String(v).trim();
    if (!t || SKIP.test(t)) return v;
    try {
      if (t.charAt(0) === '/' && t.charAt(1) !== '/' && t.indexOf(PREFIX) === 0 && parseProxy(new URL(t, ORIGIN))) return v;
      var u = new URL(t, upstreamBase());
      if (parseProxy(u)) return v;
      if (u.origin === ORIGIN && u.pathname.indexOf(BP + '/api/') !== 0) u = new URL(u.pathname + u.search + u.hash, upstreamBase());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return v;
      return PREFIX + b64e(u.origin) + u.pathname + u.search + u.hash;
    } catch (e) { return v; }
  }
  function rwSrcset(s) {
    if (/^\s*data:/i.test(s)) return s;
    return s.replace(/(^|,)(\s*)([^\s,]+)/g, function (m, a, b, u) { return a + b + rw(u); });
  }
  var ENT = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
  function unent(s) { return s.replace(/&(amp|quot|lt|gt|apos|#39);/g, function (m, n) { return n === '#39' ? "'" : ENT[n]; }); }
  function rwHtml(h) {
    if (typeof h !== 'string' || h.indexOf('<') < 0) return h;
    return h.replace(/(<[a-zA-Z][^>]*?\s)(xlink:href|href|src|action|poster|formaction|srcset)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi, function (m, pre, name, eq, q, a, b, c) {
      var val = a !== undefined ? a : b !== undefined ? b : c;
      var out = name.toLowerCase() === 'srcset' ? rwSrcset(unent(val)) : rw(unent(val));
      return pre + name + eq + '"' + String(out).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
    });
  }


  // --- location virtualisation ---
  // Rewritten scripts call __ls$g(location) etc., so pages see the real upstream URL.
  function upstreamUrl() { return new URL(parseProxy(new URL(realLocation.href)).url); }
  function navigate(u, replace) { var t = rw(u); if (replace) realLocation.replace(t); else realLocation.assign(t); }
  var fake = Object.create(Location.prototype);
  function part(name, set) {
    Object.defineProperty(fake, name, {
      enumerable: true, configurable: true,
      get: function () { return upstreamUrl()[name]; },
      set: function (v) { var u = upstreamUrl(); u[name] = v; navigate(u.href); }
    });
  }
  ['protocol', 'host', 'hostname', 'port', 'pathname', 'search'].forEach(part);
  Object.defineProperty(fake, 'origin', { enumerable: true, configurable: true, get: function () { return upstreamUrl().origin; } });
  Object.defineProperty(fake, 'hash', { enumerable: true, configurable: true, get: function () { return upstreamUrl().hash; }, set: function (v) { realLocation.hash = v; } });
  Object.defineProperty(fake, 'href', { enumerable: true, configurable: true, get: function () { return upstreamUrl().href; }, set: function (v) { navigate(v); } });
  Object.defineProperty(fake, 'ancestorOrigins', { get: function () { return realLocation.ancestorOrigins; } });
  fake.assign = function (u) { navigate(u); };
  fake.replace = function (u) { navigate(u, true); };
  fake.reload = function () { realLocation.reload(); };
  fake.toString = function () { return upstreamUrl().href; };
  Object.defineProperty(fake, Symbol.toPrimitive, { value: function () { return upstreamUrl().href; } });

  function isProxied(w) { try { return !!w.__litespeed; } catch (e) { return false; } }
  // The shell hosting this frame must stay invisible: act as the top-level window.
  function g(x) {
    if (x === realLocation) return fake;
    try {
      if (x && x.window === x && x !== window && !isProxied(x) && (x === window.top || x === window.parent)) return window;
    } catch (e) {}
    return x;
  }
  function isDocOrWin(t) { return t === window || t === document; }
  function def(name, get, set) { Object.defineProperty(Object.prototype, name, { configurable: true, enumerable: false, get: get, set: set }); }
  Object.defineProperty(window, '__ls$g', { value: g });
  function pmImpl() {
    var a = [].slice.call(arguments), w = false;
    try { w = this && this.window === this; } catch (e) {}
    if (w) {
      var t = a[1];
      if (typeof t === 'string' && t !== '*' && t !== '/') a[1] = '*';
      else if (t && typeof t === 'object' && t.targetOrigin && t.targetOrigin !== '*') a[1] = Object.assign({}, t, { targetOrigin: '*' });
    }
    return this.postMessage.apply(this, a);
  }
  // Installs the helpers that rewritten code calls onto another realm's Object.prototype. Needed whenever
  // a script can reach a window we do not run in (the hosting shell, about:blank iframes, popups).
  function install(O, W, hideAs) {
    var P = O.prototype;
    O.defineProperty(P, '__ls$loc', {
      configurable: true, enumerable: false,
      get: function () { return (this === W || this === W.document) && hideAs ? hideAs : this.location; },
      set: function (v) { if ((this === W || this === W.document) && hideAs) hideAs.href = v; else this.location = v; }
    });
    O.defineProperty(P, '__ls$top', { configurable: true, enumerable: false, get: function () { return this.top; }, set: function (v) { this.top = v; } });
    O.defineProperty(P, '__ls$parent', { configurable: true, enumerable: false, get: function () { return this.parent; }, set: function (v) { this.parent = v; } });
    O.defineProperty(P, '__ls$pm', { configurable: true, enumerable: false, writable: true, value: pmImpl });
  }
  def('__ls$loc', function () { return isDocOrWin(this) ? fake : this.location; },
    function (v) { if (isDocOrWin(this)) fake.href = v; else this.location = v; });
  def('__ls$top', function () { return g(this.top); }, function (v) { this.top = v; });
  def('__ls$parent', function () { return g(this.parent); }, function (v) { this.parent = v; });
  Object.defineProperty(Object.prototype, '__ls$pm', { configurable: true, enumerable: false, writable: true, value: pmImpl });
  function share(w, hidden) {
    try {
      if (!w || w === window || isProxied(w)) return;
      if (Object.prototype.hasOwnProperty.call(w.Object.prototype, '__ls$pm')) return;
      install(w.Object, w, hidden ? fake : null);
    } catch (e) { /* cross-origin window: nothing to install */ }
  }
  // Ancestors (the shell) are hidden behind our fake location; later-created same-origin windows get plain helpers.
  try { var anc = window; for (var depth = 0; depth < 8 && anc.parent !== anc; depth++) { anc = anc.parent; share(anc, true); } } catch (e) {}
  try {
    var cw = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { configurable: true, enumerable: cw.enumerable, get: function () { var w = cw.get.call(this); share(w, false); return w; } });
    var cd0 = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument');
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', { configurable: true, enumerable: cd0.enumerable, get: function () { var d = cd0.get.call(this); if (d) share(d.defaultView, false); return d; } });
  } catch (e) {}
  // __ls$loc as a bare identifier (location = x  ->  __ls$loc = x)
  Object.defineProperty(window, '__ls$loc', { configurable: true, get: function () { return fake; }, set: function (v) { fake.href = v; } });

  function getter(proto, prop, fn) {
    try { var d = Object.getOwnPropertyDescriptor(proto, prop); if (d && d.get) Object.defineProperty(proto, prop, { configurable: true, enumerable: d.enumerable, get: fn, set: d.set }); } catch (e) {}
  }
  getter(Document.prototype, 'URL', function () { return upstreamUrl().href; });
  getter(Document.prototype, 'documentURI', function () { return upstreamUrl().href; });
  getter(Document.prototype, 'domain', function () { return upstreamUrl().hostname; });
  try { Object.defineProperty(window, 'origin', { configurable: true, get: function () { return upstreamUrl().origin; } }); } catch (e) {}
  // All proxied pages share one real origin: make cross-window messaging behave as if they did not.
  getter(MessageEvent.prototype, 'origin', (function () {
    var d = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin').get;
    return function () {
      var o = d.call(this);
      try { if (o === ORIGIN && this.source && this.source.__litespeed) return new URL(parseProxy(new URL(this.source.location.href)).url).origin; } catch (e) {}
      return o;
    };
  })());

  // --- network ---
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) input = rw(String(input));
      else if (input && input.url) { var nu = rw(input.url); if (nu !== input.url) input = new Request(nu, input); }
    } catch (e) {}
    return _fetch.call(this, input, init);
  };
  var _Request = window.Request;
  window.Request = function (input, init) {
    if (typeof input === 'string' || input instanceof URL) input = rw(String(input));
    return new _Request(input, init);
  };
  window.Request.prototype = _Request.prototype;
  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () { var a = [].slice.call(arguments); a[1] = rw(a[1]); return xo.apply(this, a); };
  if (navigator.sendBeacon) { var sb = navigator.sendBeacon; navigator.sendBeacon = function (u, d) { return sb.call(navigator, rw(u), d); }; }
  ['EventSource', 'Worker', 'SharedWorker'].forEach(function (n) {
    var C = window[n]; if (!C) return;
    var W = function (u, o) { return new C(rw(u), o); };
    W.prototype = C.prototype; window[n] = W;
  });
  var wo = window.open;
  window.open = function (u) {
    // Popups without a user gesture are almost always ads.
    if (DS.popups === 'block' && navigator.userActivation && !navigator.userActivation.isActive) return null;
    var a = [].slice.call(arguments); if (u) a[0] = rw(u); var w = wo.apply(window, a); share(w, false); return w;
  };
  if (API && window.WebSocket) {
    var WS = window.WebSocket;
    var relay = API.replace(/^http/, 'ws') + '/api/ws';
    var PWS = function (url, protocols) {
      var abs = new URL(String(url), upstreamBase());
      if (abs.protocol === 'http:') abs.protocol = 'ws:'; else if (abs.protocol === 'https:') abs.protocol = 'wss:';
      return protocols === undefined ? new WS(relay + '?url=' + encodeURIComponent(abs.href)) : new WS(relay + '?url=' + encodeURIComponent(abs.href), protocols);
    };
    PWS.prototype = WS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { PWS[k] = WS[k]; });
    window.WebSocket = PWS;
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var o = History.prototype[m];
    History.prototype[m] = function (s, t, u) { var r = o.call(this, s, t, u == null ? u : rw(u)); report(); return r; };
  });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function () { return Promise.reject(new DOMException('Service workers are disabled by LiteSpeed.', 'SecurityError')); };
  }

  // --- DOM ---
  function hookProp(proto, prop, fn) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, { get: d.get, set: function (v) { d.set.call(this, fn(v)); }, configurable: true, enumerable: d.enumerable });
  }
  [['HTMLAnchorElement', 'href'], ['HTMLAreaElement', 'href'], ['HTMLLinkElement', 'href'], ['HTMLScriptElement', 'src'],
   ['HTMLImageElement', 'src'], ['HTMLIFrameElement', 'src'], ['HTMLSourceElement', 'src'], ['HTMLMediaElement', 'src'],
   ['HTMLTrackElement', 'src'], ['HTMLEmbedElement', 'src'], ['HTMLObjectElement', 'data'], ['HTMLInputElement', 'src'],
   ['HTMLFormElement', 'action'], ['HTMLVideoElement', 'poster']].forEach(function (p) { hookProp(window[p[0]] && window[p[0]].prototype, p[1], rw); });
  hookProp(window.HTMLImageElement && HTMLImageElement.prototype, 'srcset', rwSrcset);
  hookProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'srcset', rwSrcset);
  hookProp(Element.prototype, 'innerHTML', rwHtml);
  hookProp(Element.prototype, 'outerHTML', rwHtml);
  var iah = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, h) { return iah.call(this, pos, rwHtml(h)); };
  var ccf = Range.prototype.createContextualFragment;
  Range.prototype.createContextualFragment = function (h) { return ccf.call(this, rwHtml(h)); };
  var dw = document.write, dwl = document.writeln;
  document.write = function () { return dw.apply(document, [].map.call(arguments, rwHtml)); };
  document.writeln = function () { return dwl.apply(document, [].map.call(arguments, rwHtml)); };


  // --- CSS url() reaching the page through script (CSSOM, <style> text, shadow roots) ---
  var CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
  function rwCss(css) {
    if (typeof css !== 'string' || (css.indexOf('url(') < 0 && css.indexOf('@import') < 0)) return css;
    return css.replace(CSS_URL, function (m, a, b, c, d, e) {
      var raw = a !== undefined ? a : b !== undefined ? b : c !== undefined ? c : d !== undefined ? d : e;
      var out = raw === undefined ? raw : rw(raw);
      if (out === raw) return m;
      return m.charAt(0) === '@' ? '@import "' + out + '"' : 'url("' + out + '")';
    });
  }
  (function () {
    var sd = CSSStyleDeclaration.prototype;
    var sp = sd.setProperty;
    sd.setProperty = function (n, v, pr) { return sp.call(this, n, typeof v === 'string' ? rwCss(v) : v, pr); };
    hookProp(sd, 'cssText', rwCss);
    if (window.CSSStyleSheet) {
      var ir = CSSStyleSheet.prototype.insertRule;
      CSSStyleSheet.prototype.insertRule = function (r, i) { return ir.call(this, rwCss(r), i); };
      ['replace', 'replaceSync'].forEach(function (m) {
        var o = CSSStyleSheet.prototype[m];
        if (o) CSSStyleSheet.prototype[m] = function (t) { return o.call(this, rwCss(t)); };
      });
    }
    // <style> contents set through textContent / innerText
    [[Node.prototype, 'textContent'], [HTMLElement.prototype, 'innerText']].forEach(function (pair) {
      var d = Object.getOwnPropertyDescriptor(pair[0], pair[1]);
      if (!d || !d.set) return;
      Object.defineProperty(pair[0], pair[1], { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, this.nodeName === 'STYLE' ? rwCss(v) : v); } });
    });
    // HTML parsed inside shadow roots and by the newer setHTML APIs bypasses Element.innerHTML
    if (window.ShadowRoot) hookProp(ShadowRoot.prototype, 'innerHTML', rwHtml);
    [Element.prototype, window.ShadowRoot && ShadowRoot.prototype].forEach(function (proto) {
      if (!proto || !proto.setHTMLUnsafe) return;
      var o = proto.setHTMLUnsafe;
      proto.setHTMLUnsafe = function (h, opts) { return o.call(this, rwHtml(h), opts); };
    });
    if (Document.parseHTMLUnsafe) { var pu = Document.parseHTMLUnsafe; Document.parseHTMLUnsafe = function (h, o) { return pu.call(Document, rwHtml(h), o); }; }
  })();

  var URLATTR = { href: 1, src: 1, action: 1, poster: 1, formaction: 1, 'xlink:href': 1 };
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    var k = String(n).toLowerCase();
    if (URLATTR[k]) v = rw(v);
    else if (k === 'srcset') v = rwSrcset(String(v));
    else if (k === 'style') v = rwCss(String(v));
    else if (k === 'data' && this.tagName === 'OBJECT') v = rw(v);
    else if (k === 'integrity') return;
    return sa.call(this, n, v);
  };
  var san = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, n, v) {
    var k = String(n).toLowerCase();
    if (k === 'href' || k === 'xlink:href') v = rw(v);
    return san.call(this, ns, n, v);
  };
  // Safety net for nodes inserted by other means (template cloning, adoption) and for inline styles set
  // through CSSOM. Chrome defines CSS longhands per element instance, so they cannot be hooked on a prototype;
  // the observer's callback runs before style resolution, so the browser never fetches the unrewritten URL.
  var MO_OPTS = { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] };
  var mo = new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      if (m.type === 'attributes') {
        var el0 = m.target, sv = el0.getAttribute('style');
        if (sv && sv.indexOf('url(') >= 0) { var rv = rwCss(sv); if (rv !== sv) sa.call(el0, 'style', rv); }
        return;
      }
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 3 && n.parentNode && n.parentNode.nodeName === 'STYLE') { var t = rwCss(n.data); if (t !== n.data) n.data = t; return; }
        if (n.nodeType === 1 && n.nodeName === 'STYLE') { var c = n.textContent, r = rwCss(c); if (r !== c) n.textContent = r; }
        if (n.nodeType !== 1) return;
        var els = [n].concat([].slice.call(n.querySelectorAll ? n.querySelectorAll('[src],[href],[action],[poster],[style]') : []));
        els.forEach(function (el) {
          for (var a in URLATTR) {
            var v = el.getAttribute && el.getAttribute(a);
            if (v) { var o = rw(v); if (o !== v) sa.call(el, a, o); }
          }
          var st = el.getAttribute && el.getAttribute('style');
          if (st && st.indexOf('url(') >= 0) { var rs = rwCss(st); if (rs !== st) sa.call(el, 'style', rs); }
        });
      });
    });
  });
  mo.observe(document, MO_OPTS);
  var attachShadow0 = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    var root = attachShadow0.call(this, init);
    try { mo.observe(root, MO_OPTS); } catch (e) {}
    return root;
  };

  // --- state isolation (all proxied sites share one origin) ---
  function curKey() { return parseProxy(new URL(location.href)).key; }
  var cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (MODE === 'sw') {
    // Cookies live in the service worker's jar; this is a synchronous mirror kept fresh by the SW.
    var mirror = ''; try { mirror = decodeURIComponent(DS.cookie || ''); } catch (e) {}
    var sw = function () { return navigator.serviceWorker && navigator.serviceWorker.controller; };
    var refresh = function () {
      var c = sw(); if (!c) return;
      var ch = new MessageChannel();
      ch.port1.onmessage = function (e) { if (typeof e.data === 'string') mirror = e.data; };
      c.postMessage({ ls: 'cookie-get', url: upstreamUrl().href }, [ch.port2]);
    };
    if ('BroadcastChannel' in window) {
      var timer = 0;
      new BroadcastChannel('litespeed-cookies').onmessage = function () { clearTimeout(timer); timer = setTimeout(refresh, 40); };
    }
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get: function () { return mirror; },
      set: function (v) {
        var str = String(v), c = sw();
        if (c) c.postMessage({ ls: 'cookie-set', url: upstreamUrl().href, cookie: str });
        var kv = str.split(';')[0], eq = kv.indexOf('='), name = kv.slice(0, eq).trim(), val = kv.slice(eq + 1).trim();
        var gone = /max-age\s*=\s*-?0+\s*(;|$)|max-age\s*=\s*-/i.test(str) || /expires\s*=\s*[^;]*(19[0-9]{2}|1970)/i.test(str);
        var parts = mirror ? mirror.split('; ').filter(function (p) { return p.slice(0, p.indexOf('=')) !== name; }) : [];
        if (!gone) parts.push(name + '=' + val);
        mirror = parts.join('; ');
      }
    });
  } else {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get: function () { return cd.get.call(this); },
      set: function (v) {
        var parts = String(v).split(';'), out = [parts[0]];
        for (var i = 1; i < parts.length; i++) {
          var p = parts[i].trim(), k = p.split('=')[0].toLowerCase();
          if (k === 'expires' || k === 'max-age') out.push(p);
        }
        out.push('Path=' + PREFIX + curKey() + '/', 'Secure', 'SameSite=None', 'Partitioned');
        cd.set.call(this, out.join('; '));
      }
    });
  }
  function nsStorage(real) {
    var pre = 'ls:' + curKey() + ':';
    function keys() { var r = []; for (var i = 0; i < real.length; i++) { var k = real.key(i); if (k.indexOf(pre) === 0) r.push(k.slice(pre.length)); } return r; }
    var api = {
      getItem: function (k) { return real.getItem(pre + k); },
      setItem: function (k, v) { real.setItem(pre + k, v); },
      removeItem: function (k) { real.removeItem(pre + k); },
      clear: function () { keys().forEach(function (k) { real.removeItem(pre + k); }); },
      key: function (i) { var k = keys(); return i < k.length ? k[i] : null; }
    };
    return new Proxy(api, {
      get: function (t, p) { if (p === 'length') return keys().length; if (p in t) return t[p]; return typeof p === 'string' ? real.getItem(pre + p) ?? undefined : undefined; },
      set: function (t, p, v) { real.setItem(pre + p, v); return true; },
      deleteProperty: function (t, p) { real.removeItem(pre + p); return true; },
      has: function (t, p) { return p in t || real.getItem(pre + String(p)) !== null; },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) { var v = real.getItem(pre + String(p)); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; }
    });
  }
  ['localStorage', 'sessionStorage'].forEach(function (n) {
    try { var s = nsStorage(window[n]); Object.defineProperty(window, n, { configurable: true, get: function () { return s; } }); } catch (e) {}
  });
  if (window.IDBFactory) {
    ['open', 'deleteDatabase'].forEach(function (m) {
      var o = IDBFactory.prototype[m];
      IDBFactory.prototype[m] = function (name) { var a = [].slice.call(arguments); a[0] = 'ls:' + curKey() + ':' + name; return o.apply(this, a); };
    });
  }

  // --- shell integration (address bar, title, back/forward, timings) ---
  var parentOrigin = null;
  function timings() {
    try {
      var n = performance.getEntriesByType('navigation')[0];
      return { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), server: n.serverTiming ? [].map.call(n.serverTiming, function (s) { return { name: s.name, dur: s.duration, desc: s.description }; }) : [] };
    } catch (e) { return null; }
  }
  var pending = 0;
  function report() {
    if (!parentOrigin || pending) return;
    pending = setTimeout(function () {
      pending = 0;
      var p = parseProxy(new URL(location.href));
      if (p) parent.postMessage({ litespeed: 'nav', url: p.url, title: document.title, timing: timings() }, parentOrigin);
    }, 30);
  }
  if (window.parent !== window) {
    window.addEventListener('message', function (e) {
      if (e.source !== parent || !e.data || !e.data.litespeed) return;
      if (e.data.litespeed === 'hello') { parentOrigin = e.origin; report(); }
      else if (e.data.litespeed === 'cmd') {
        var c = e.data.cmd;
        if (c === 'back') history.back(); else if (c === 'forward') history.forward();
        else if (c === 'reload') location.reload(); else if (c === 'stop') window.stop();
      }
    });
    parent.postMessage({ litespeed: 'ready' }, '*');
    ['DOMContentLoaded', 'load', 'popstate', 'hashchange'].forEach(function (ev) { window.addEventListener(ev, report); });
    document.addEventListener('DOMContentLoaded', function () {
      var t = document.querySelector('title');
      if (t) new MutationObserver(report).observe(t, { childList: true, characterData: true, subtree: true });
    });
  }
})();
`;
