import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleSw } from '../scripts/build-sw.mjs';

// web/sw.js is committed (GitHub Pages can serve a branch with no build step), so it must match the sources.
test('web/sw.js is up to date with src/ (run `npm run build:sw` if this fails)', async () => {
  const built = Buffer.from(await bundleSw());
  const committed = readFileSync(new URL('../web/sw.js', import.meta.url));
  assert.ok(built.equals(committed), 'web/sw.js is stale');
});

test('the service worker bundle is a single self-contained script', () => {
  const src = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(src));
  assert.ok(src.length < 400 * 1024, `sw.js is ${src.length} bytes`);
});
