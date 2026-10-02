// Client runtime injected into proxied HTML documents.
// Kept as a plain string so it bundles on every platform (no fs access needed).
// Constraint: this source must not contain backticks or dollar-brace sequences.
export const RUNTIME_SOURCE = String.raw`(function () {
  'use strict';
  if (window.__litespeed) return;
  var script = document.currentScript;
  if (!script || !script.src) return;
  var BP = new URL(script.src, location.href).pathname.replace(/\/api\/runtime\.js$/, '');
  var PREFIX = BP + '/p/';
  var ORIGIN = location.origin;

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
  window.__litespeed = { version: 1 };

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
    return h.replace(/(<[a-zA-Z][^>]*?\s)(href|src|action|poster|formaction|srcset)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi, function (m, pre, name, eq, q, a, b, c) {
      var val = a !== undefined ? a : b !== undefined ? b : c;
      var out = name.toLowerCase() === 'srcset' ? rwSrcset(unent(val)) : rw(unent(val));
      return pre + name + eq + '"' + String(out).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
    });
  }

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
  window.open = function (u) { var a = [].slice.call(arguments); if (u) a[0] = rw(u); return wo.apply(window, a); };
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

  var URLATTR = { href: 1, src: 1, action: 1, poster: 1, formaction: 1 };
  var sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    var k = String(n).toLowerCase();
    if (URLATTR[k]) v = rw(v);
    else if (k === 'srcset') v = rwSrcset(String(v));
    else if (k === 'data' && this.tagName === 'OBJECT') v = rw(v);
    else if (k === 'integrity') return;
    return sa.call(this, n, v);
  };
  // Safety net for nodes inserted by other means (template cloning, adoption).
  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        var els = [n].concat([].slice.call(n.querySelectorAll ? n.querySelectorAll('[src],[href],[action],[poster]') : []));
        els.forEach(function (el) {
          for (var a in URLATTR) {
            var v = el.getAttribute && el.getAttribute(a);
            if (v) { var o = rw(v); if (o !== v) sa.call(el, a, o); }
          }
        });
      });
    });
  }).observe(document, { childList: true, subtree: true });

  // --- state isolation (all proxied sites share one origin) ---
  function curKey() { return parseProxy(new URL(location.href)).key; }
  var cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
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
