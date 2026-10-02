import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOrigin, decodeOrigin, toProxyPath, parseProxyPath, resolveTarget, rewriteUrl } from '../src/url/codec.js';

test('origin key round-trips', () => {
  for (const o of ['https://example.com', 'http://a.b:8080', 'https://xn--bcher-kva.example']) {
    assert.equal(decodeOrigin(encodeOrigin(o)), o);
  }
  assert.equal(decodeOrigin('not-base64!!'), null);
  assert.equal(decodeOrigin(encodeOrigin('ftp://x.com')), null);
});

test('proxy paths parse back', () => {
  const p = toProxyPath(new URL('https://example.com/a/b?q=1#h'), '');
  assert.match(p, /^\/p\/[\w-]+\/a\/b\?q=1#h$/);
  const parsed = parseProxyPath(p.split('?')[0].split('#')[0], '');
  assert.equal(parsed.origin, 'https://example.com');
  assert.equal(parsed.rest, '/a/b');
});

test('basePath is honoured', () => {
  const p = toProxyPath(new URL('https://example.com/x'), '/lite');
  assert.ok(p.startsWith('/lite/p/'));
  assert.ok(parseProxyPath(p, '/lite'));
  assert.equal(parseProxyPath(p, ''), null);
});

test('resolveTarget does not let // change the host', () => {
  const key = encodeOrigin('https://example.com');
  const t = resolveTarget(new URL(`http://px/p/${key}//evil.com/x?y=1`), '');
  assert.equal(t.url.host, 'example.com');
  assert.equal(t.url.pathname, '//evil.com/x');
});

test('rewriteUrl handles relative, absolute, protocol-relative and skipped schemes', () => {
  const base = new URL('https://example.com/dir/page.html');
  const k = encodeOrigin('https://example.com');
  assert.equal(rewriteUrl('img.png', base), `/p/${k}/dir/img.png`);
  assert.equal(rewriteUrl('/root.css?v=2', base), `/p/${k}/root.css?v=2`);
  assert.equal(rewriteUrl('../up', base), `/p/${k}/up`);
  assert.equal(rewriteUrl('//cdn.x.com/a.js', base), `/p/${encodeOrigin('https://cdn.x.com')}/a.js`);
  assert.equal(rewriteUrl('https://other.org:8443/p', base), `/p/${encodeOrigin('https://other.org:8443')}/p`);
  for (const s of ['#top', 'data:image/png;base64,AAA', 'javascript:void(0)', 'mailto:a@b.c', 'tel:1', 'blob:x', '']) {
    assert.equal(rewriteUrl(s, base), s);
  }
});
