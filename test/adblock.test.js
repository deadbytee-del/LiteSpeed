import test from 'node:test';
import assert from 'node:assert/strict';
import { FilterEngine, createAdblock, blockedResponse, registrable } from '../src/adblock/index.js';

const e = (rules) => new FilterEngine().add(rules);
const blocked = (eng, url, type = 'script', pageUrl = 'https://site.com/') => eng.check({ url, type, pageUrl }).blocked;

test('domain rules match subdomains, not look-alikes', () => {
  const f = e('||ads.example.com^');
  assert.ok(blocked(f, 'https://ads.example.com/x.js'));
  assert.ok(blocked(f, 'https://eu.ads.example.com/x.js'));
  assert.ok(!blocked(f, 'https://notads.example.com/x.js'));
  assert.ok(!blocked(f, 'https://example.com/ads.example.com'));
});

test('wildcards, separators, anchors and exceptions', () => {
  const f = e('/banner/*/img^\n|https://track.test/p?\n.gif|\n@@||cdn.good.com/banner/ok/img^');
  assert.ok(blocked(f, 'https://a.com/banner/300x250/img?x=1'));
  assert.ok(!blocked(f, 'https://a.com/banner/300x250/imgs'));
  assert.ok(blocked(f, 'https://track.test/p?id=1'));
  assert.ok(!blocked(f, 'http://track.test/p?id=1'));
  assert.ok(blocked(f, 'https://a.com/pixel.gif'));
  assert.ok(!blocked(f, 'https://a.com/pixel.gif?x'));
  assert.ok(!blocked(f, 'https://cdn.good.com/banner/ok/img'));
});

test('options: type, third-party, domain', () => {
  const f = e('||tracker.com^$third-party,script\n||only.com^$domain=a.com|~b.a.com\n||img.com^$~image');
  assert.ok(blocked(f, 'https://tracker.com/t.js', 'script', 'https://site.com/'));
  assert.ok(!blocked(f, 'https://tracker.com/t.js', 'image', 'https://site.com/'));
  assert.ok(!blocked(f, 'https://tracker.com/t.js', 'script', 'https://www.tracker.com/'));
  assert.ok(blocked(f, 'https://only.com/x', 'script', 'https://a.com/'));
  assert.ok(!blocked(f, 'https://only.com/x', 'script', 'https://b.a.com/'));
  assert.ok(!blocked(f, 'https://only.com/x', 'script', 'https://c.com/'));
  assert.ok(blocked(f, 'https://img.com/x', 'script'));
  assert.ok(!blocked(f, 'https://img.com/x', 'image'));
});

test('navigations are never blocked; unsupported rules are skipped', () => {
  const f = e('||example.com^\n||x.com^$redirect=noop.js\n/regex(ad)+/\n##.a:has-text(Ad)');
  assert.ok(!blocked(f, 'https://example.com/', 'document'));
  assert.ok(!blocked(f, 'https://x.com/a.js'));
  assert.equal(f.counts.skipped, 3);
});

test('cosmetic rules: generic, per-domain, exceptions', () => {
  const f = e('##.ad\nsite.com##.promo\nsite.com#@#.ad');
  assert.match(f.cosmeticCss('other.org'), /\.ad/);
  assert.doesNotMatch(f.cosmeticCss('other.org'), /promo/);
  assert.match(f.cosmeticCss('www.site.com'), /\.promo/);
  assert.doesNotMatch(f.cosmeticCss('www.site.com'), /\.ad[,{]/);
});

test('default list blocks well-known ad/tracker hosts and spares ordinary ones', () => {
  const f = createAdblock();
  for (const u of ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://www.google-analytics.com/analytics.js', 'https://connect.facebook.net/en_US/fbevents.js']) assert.ok(blocked(f, u, 'script'), u);
  for (const u of ['https://example.com/app.js', 'https://cdn.jsdelivr.net/npm/x.js', 'https://fonts.googleapis.com/css', 'https://connect.facebook.net/en_US/sdk.js', 'https://www.google.com/recaptcha/api.js']) assert.ok(!blocked(f, u, 'script'), u);
});

test('blocked responses are typed', async () => {
  assert.equal(blockedResponse('image').headers.get('content-type'), 'image/gif');
  assert.equal(blockedResponse('script').headers.get('content-type'), 'text/javascript');
  assert.equal(blockedResponse('empty').status, 204);
  assert.equal(registrable('a.b.example.co.uk'), 'example.co.uk');
});

test('lookup stays fast with a large list', () => {
  const lines = [];
  for (let i = 0; i < 60000; i++) lines.push(i % 3 ? `||ad${i}.example${i % 997}.com^` : `/seg${i}/banner${i}.js`);
  const f = e(lines.join('\n'));
  const t = performance.now();
  for (let i = 0; i < 20000; i++) f.check({ url: `https://cdn${i}.site.org/assets/app${i}.js?v=${i}`, type: 'script', pageUrl: 'https://site.org/' });
  const per = (performance.now() - t) / 20000;
  assert.ok(per < 0.05, `${per.toFixed(4)} ms per check`);
});
