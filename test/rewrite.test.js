import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlRewriter, createHtmlTransform, rewriteSrcset } from '../src/rewrite/html.js';
import { rewriteCss } from '../src/rewrite/css.js';
import { rewriteModuleSpecifiers } from '../src/rewrite/js.js';
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

test('module specifier rewriting is limited to absolute specifiers', () => {
  const code = 'import a from "https://esm.test/a.js"; import "./local.js"; export * from "//cdn.test/b.js"; const x = import("https://esm.test/c.js"); const s = "https://not-an-import.test";';
  const out = rewriteModuleSpecifiers(code, new URL(base), '');
  assert.match(out, new RegExp(`from "/p/${encodeOrigin('https://esm.test')}/a.js"`));
  assert.match(out, /import "\.\/local\.js"/);
  assert.match(out, new RegExp(`from "/p/${encodeOrigin('https://cdn.test')}/b.js"`));
  assert.match(out, new RegExp(`import\\("/p/${encodeOrigin('https://esm.test')}/c.js"\\)`));
  assert.match(out, /"https:\/\/not-an-import.test"/);
});
