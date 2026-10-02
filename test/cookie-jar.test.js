import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../src/cookie-jar.js';

const U = (s) => new URL(s);

test('host-only vs domain cookies, paths and secure', async () => {
  const j = new CookieJar();
  await j.setFromHeaders(U('https://a.example.com/dir/page'), ['h=1', 'd=2; Domain=example.com; Path=/', 'p=3; Path=/dir', 's=4; Path=/; Secure', 'bad=5; Domain=other.com']);
  // longest path first; host-only cookie h is on /dir by default-path rules
  assert.equal(await j.header(U('https://a.example.com/dir/x')), 'h=1; p=3; d=2; s=4');
  assert.equal(await j.header(U('https://b.example.com/')), 'd=2');
  assert.equal(await j.header(U('https://a.example.com/other')), 'd=2; s=4');
  assert.equal(await j.header(U('http://a.example.com/other')), 'd=2');
  assert.equal(await j.header(U('https://a.example.com/directory')), 'd=2; s=4');
});

test('expiry, Max-Age deletion, HttpOnly hidden from scripts', async () => {
  let t = 1_000_000;
  const j = new CookieJar({ now: () => t });
  await j.setFromHeaders(U('https://x.test/'), ['a=1; Max-Age=10', 'b=2; HttpOnly', 'c=3']);
  assert.equal(await j.header(U('https://x.test/')), 'a=1; b=2; c=3');
  assert.equal(await j.scriptView(U('https://x.test/')), 'a=1; c=3');
  t += 11_000;
  assert.equal(await j.header(U('https://x.test/')), 'b=2; c=3');
  await j.setFromHeaders(U('https://x.test/'), ['c=; Max-Age=0']);
  assert.equal(await j.header(U('https://x.test/')), 'b=2');
  await j.setFromHeaders(U('https://x.test/'), ['b=hacked'], { fromScript: true });
  assert.equal(await j.header(U('https://x.test/')), 'b=2');
});

test('overwrites by name+domain+path and honours cookie prefixes', async () => {
  const j = new CookieJar();
  await j.setFromHeaders(U('https://x.test/'), ['a=1', 'a=2', '__Host-id=1; Secure; Path=/', '__Host-bad=1; Path=/x', '__Secure-n=1']);
  assert.equal(await j.header(U('https://x.test/')), 'a=2; __Host-id=1');
});

test('persists through the store', async () => {
  let saved;
  const j = new CookieJar({ store: { load: async () => [], save: async (c) => { saved = c; } } });
  await j.setFromHeaders(U('https://x.test/'), ['k=v; Max-Age=100']);
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(saved[0].name, 'k');
  const j2 = new CookieJar({ store: { load: async () => saved, save: async () => {} } });
  assert.equal(await j2.header(U('https://x.test/')), 'k=v');
});
