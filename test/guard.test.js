import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget } from '../src/security/guard.js';
import { loadConfig } from '../src/config.js';
import { rewriteSetCookie } from '../src/cookies.js';

const cfg = loadConfig({});
const blocked = (u, c = cfg) => assert.throws(() => checkTarget(new URL(u), c, 'proxy.test'), (e) => e.status >= 400);
const ok = (u, c = cfg) => assert.doesNotThrow(() => checkTarget(new URL(u), c, 'proxy.test'));

test('blocks private, loopback, metadata and internal targets', () => {
  for (const u of [
    'http://localhost/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.1.2.3/', 'http://192.168.0.1/',
    'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/',
    'http://intranet/', 'http://db.internal/', 'http://printer.local/', 'file:///etc/passwd', 'ftp://example.com/', 'http://user:pw@example.com/',
    'http://proxy.test/p/x',
  ]) blocked(u);
});

test('allows public targets and honours allow/block lists', () => {
  ok('https://example.com/'); ok('http://93.184.216.34/'); ok('https://sub.example.co.uk:8443/x');
  blocked('https://evil.example.com/', loadConfig({ LITESPEED_BLOCKED_HOSTS: 'example.com' }));
  blocked('https://other.org/', loadConfig({ LITESPEED_ALLOWED_HOSTS: 'example.com' }));
  ok('https://a.example.com/', loadConfig({ LITESPEED_ALLOWED_HOSTS: 'example.com' }));
  ok('http://127.0.0.1/', loadConfig({ LITESPEED_ALLOW_PRIVATE: 'on' }));
});

test('set-cookie is scoped to the upstream origin path', () => {
  const c = rewriteSetCookie('sid=abc; Domain=example.com; Path=/app; Secure; HttpOnly; SameSite=Lax; Max-Age=60', 'KEY', '');
  assert.equal(c, 'sid=abc; HttpOnly; Max-Age=60; Path=/p/KEY/; Secure; SameSite=None; Partitioned');
  assert.equal(rewriteSetCookie('__Host-x=1; Path=/; Secure', 'KEY'), null);
});
