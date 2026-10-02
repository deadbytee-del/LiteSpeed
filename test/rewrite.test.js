import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlRewriter, createHtmlTransform, rewriteSrcset } from '../src/rewrite/html.js';
import { rewriteCss } from '../src/rewrite/css.js';
import { rewriteJs } from '../src/rewrite/js.js';
import { parse } from 'acorn';
import { encodeOrigin } from '../src/url/codec.js';

const base = 'https://example.com/a/index.html';
const K = encodeOrigin('https://example.com');
const mk = (opts = {}) => new HtmlRewriter({ base, basePath: '', runtimeSrc: '/api/runtime.js?v=1', ...opts });
const run = (html, opts) => { const r = mk(opts); return r.process(html) + r.process('', true); };

test('rewrites url attributes and decodes entities', () => {
  const out = run('<html><head></head><body><a href="b?x=1&amp;y=2">l</a><img src=\'/i.png\'><form action=post></form></body></html>');
  assert.match(out, new RegExp(`href="/p/${K}/a/b\\?x=1&amp;y=2"`));
  assert.match(out, new RegExp(`src="/p/${K}/i.png"`));
  assert.match(out, new RegExp(`action="/p/${K}/a/post"`));
});

test('injects runtime once, right after <head>', () => {
  const out = run('<!doctype html><html><head><title>t</title></head><body><script src="x.js"></script></body></html>');
  assert.equal(out.split('/api/runtime.js').length - 1, 1);
  assert.ok(out.indexOf('<head><script src="/api/runtime.js') > 0);
});

test('injects before body when there is no head, and not at all when disabled', () => {
  assert.match(run('<html><body>x</body></html>'), /<script src="\/api\/runtime\.js\?v=1"><\/script><body>/);
  assert.doesNotMatch(run('<html><head></head></html>', { inject: false }), /runtime/);
});

test('strips integrity and CSP meta, rewrites meta refresh, base and target', () => {
  const out = run('<head><meta http-equiv="Content-Security-Policy" content="x"><meta http-equiv="refresh" content="3; url=/next"><base href="/sub/"><script src="a.js" integrity="sha256-x"></script></head><a href="y" target="_top">');
  assert.doesNotMatch(out, /Content-Security-Policy/i);
  assert.doesNotMatch(out, /integrity/);
  assert.match(out, new RegExp(`content="3; url=/p/${K}/next"`));
  assert.match(out, new RegExp(`<base href="/p/${K}/sub/">`));
  assert.match(out, new RegExp(`src="/p/${K}/sub/a.js"`)); // base applied
  assert.match(out, /target="_self"/);
});

test('rewrites srcset and inline style', () => {
  assert.equal(rewriteSrcset('a.png 1x, b.png 2x', new URL(base), ''), `/p/${K}/a/a.png 1x, /p/${K}/a/b.png 2x`.replace('/p/', '/p/'));
  const out = run('<div style="background:url(bg.png)"></div><style>.a{background:url("/x.png")}</style>');
  assert.match(out, new RegExp(`url\\(&quot;/p/${K}/a/bg.png&quot;\\)`));
  assert.match(out, new RegExp(`url\\("/p/${K}/x.png"\\)`));
});

test('scripts and comments pass through untouched', () => {
  const src = '<script>var a = "<a href=\\"/x\\">"; if (a<b) {}</script><!-- <a href="/c"> -->';
  const out = run(src, { inject: false });
  assert.equal(out, src);
});

test('output is identical regardless of chunk boundaries', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>a{background:url(a.png)}</style></head><body><a href="x">t</a><!-- c --><script>if(1<2){}</script><img src="//cdn.test/p.png" alt="a>b"><textarea><a href="no"></textarea></body></html>';
  const whole = run(html);
  for (let size = 1; size < 40; size += 3) {
    const r = mk();
    let out = '';
    for (let i = 0; i < html.length; i += size) out += r.process(html.slice(i, i + size));
    out += r.process('', true);
    assert.equal(out, whole, `chunk size ${size}`);
  }
  assert.match(whole, /<textarea><a href="no"><\/textarea>/);
});

test('transform stream decodes non-UTF-8 charsets and emits UTF-8', async () => {
  const t = createHtmlTransform({ base, basePath: '', runtimeSrc: '/r.js', inject: false, charset: 'iso-8859-1' });
  const w = t.writable.getWriter();
  w.write(Uint8Array.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); // <p>é</p>
  w.close();
  const chunks = [];
  for await (const c of t.readable) chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '<p>é</p>');
});

test('css rewriting', () => {
  const css = '@import "/a.css"; @import url(b.css); .x{background:url( "i.png" )} .y{background:url(data:image/png;base64,AA==)} @font-face{src:url(//f.test/f.woff2)}';
  const out = rewriteCss(css, new URL(base), '');
  assert.match(out, new RegExp(`@import "/p/${K}/a.css"`));
  assert.match(out, new RegExp(`url\\("/p/${K}/a/b.css"\\)`));
  assert.match(out, new RegExp(`url\\("/p/${K}/a/i.png"\\)`));
  assert.match(out, /url\(data:image\/png;base64,AA==\)/);
  assert.match(out, new RegExp(`url\\("/p/${encodeOrigin('https://f.test')}/f.woff2"\\)`));
  assert.equal(rewriteCss('a{color:red}', new URL(base), ''), 'a{color:red}');
});

const js = (code) => rewriteJs(code, new URL(base), '');
const valid = (code) => { try { parse(code, { ecmaVersion: 'latest' }); } catch { parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); } };

test('js: location reads/writes and frame-busting are redirected to the runtime helpers', () => {
  assert.equal(js('var a=location.href;'), 'var a=__ls$g(location).href;');
  assert.equal(js('document.location.assign(x); window.location = y'), 'document.__ls$loc.assign(x); window.__ls$loc = y');
  assert.equal(js('location=url;'), '__ls$loc=url;');
  assert.equal(js('if(top!==self)top.location=self.location;'), 'if(__ls$g(top)!==self)__ls$g(top).__ls$loc=self.__ls$loc;');
  assert.equal(js('window.top.x; parent.postMessage(1,"*")'), 'window.__ls$top.x; __ls$g(parent).__ls$pm(1,"*")');
  assert.equal(js('y = c ? location : o; z = typeof location'), 'y = c ? __ls$g(location) : o; z = typeof __ls$g(location)');
});

test('js: shadowed names, object keys, shorthand, properties and plain code are left alone (and stay valid)', () => {
  const keep = [
    'function f(location){return 1}', 'const {location}=window;', 'x={location,a:1}; y={location:2}', 'function g(a,location=1){}',
    'var parent = 3; el.style.top="1px"; var r=el.top; node.parent.x', 'class A{ get location(){return 1} static top(){} }',
    'foo(location); a = b / location / c; const re = /location/g;', 'const nothing = 1;',
  ];
  for (const c of keep) { const o = js(c); valid(o); assert.ok(!o.includes('__ls$loc =') || c.includes('='), c); }
  assert.equal(js('function f(location){return 1}'), 'function f(location){return 1}');
  assert.equal(js('x={location,a:1}; y={location:2}'), 'x={location,a:1}; y={location:2}');
  assert.equal(js('el.style.top="1px"; var r=el.top;'), 'el.style.top="1px"; var r=el.top;');
});

test('js: a shadowing parameter still works because __ls$g returns non-Location values unchanged', () => {
  const o = js('function f(location){return location.pathname}');
  assert.equal(o, 'function f(location){return __ls$g(location).pathname}');
  valid(o);
});

test('js: output stays valid on template literals, regex and modern syntax', () => {
  for (const c of ['let s = `a ${location.href} b`;', 'const f = async (location) => { await location.x }', 'a?.b?.location?.c; x ??= location.y', 'label: for(;;){ break label }', '#!/usr/bin/env node\nlocation.reload()']) valid(js(c));
});

test('js: module specifiers that are absolute or root-relative are proxied; relative and bare are not', () => {
  const out = js('import a from "https://esm.test/a.js"; import("/lazy.js"); import "./rel.js"; import b from "bare-pkg"; export * from "//cdn.test/b.js"; const s = "https://not-an-import.test";');
  assert.match(out, new RegExp(`from "/p/${encodeOrigin('https://esm.test')}/a.js"`));
  assert.match(out, new RegExp(`import\\("/p/${K}/lazy.js"\\)`));
  assert.match(out, /import "\.\/rel\.js"/);
  assert.match(out, /from "bare-pkg"/);
  assert.match(out, new RegExp(`from "/p/${encodeOrigin('https://cdn.test')}/b.js"`));
  assert.match(out, /"https:\/\/not-an-import.test"/);
});

test('js: unparseable input is returned untouched', () => {
  const bad = 'var x = location.href; @@@ not js ###';
  assert.equal(js(bad), bad);
});

test('html: inline scripts are rewritten, JSON/module-less data blocks and external scripts are not', () => {
  const out = run('<script>a = location.href</script><script type="application/json">{"location":"x"}</script><script type="module">import "/m.js"; location.reload()</script><script src="x.js"></script>', { inject: false });
  assert.match(out, /<script>a = __ls\$g\(location\)\.href<\/script>/);
  assert.match(out, /<script type="application\/json">\{"location":"x"\}<\/script>/);
  assert.match(out, new RegExp(`import "/p/${K}/m.js"; __ls\\$g\\(location\\)\\.reload\\(\\)`));
});

test('html: inline script rewriting is independent of chunk boundaries', () => {
  const html = '<html><head></head><body><script>if (location.hash) { x = top.location.href }</script><p>t</p></body></html>';
  const whole = run(html);
  for (let size = 1; size < 30; size += 4) {
    const r = mk();
    let out = '';
    for (let i = 0; i < html.length; i += size) out += r.process(html.slice(i, i + size));
    out += r.process('', true);
    assert.equal(out, whole, `chunk size ${size}`);
  }
  assert.match(whole, /__ls\$g\(location\)\.hash/);
});

test('js: frame-busting comparisons use the virtual top/parent', () => {
  assert.equal(js('if (top === self) go()'), 'if (__ls$g(top) === self) go()');
  assert.equal(js('if (self !== top) bust()'), 'if (self !== __ls$g(top)) bust()');
  assert.equal(js('x = parent == window'), 'x = __ls$g(parent) == window');
  valid(js('var top = 1; function f(parent){ return parent != null }'));
});

test('js: x.postMessage(...) call sites go through the realm-correct helper', () => {
  assert.equal(js('parent.postMessage(m, "https://up.test")'), '__ls$g(parent).__ls$pm(m, "https://up.test")');
  assert.equal(js('iframe.contentWindow.postMessage(a, b)'), 'iframe.contentWindow.__ls$pm(a, b)');
  assert.equal(js('const f = obj.postMessage; w.postMessage'), 'const f = obj.postMessage; w.postMessage');
  valid(js('worker.postMessage({a:1}, [buf])'));
});
