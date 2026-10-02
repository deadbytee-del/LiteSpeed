import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_SOURCE } from '../src/runtime/client.js';
import { VERSION } from '../src/version.js';
import { readFileSync } from 'node:fs';

test('runtime source parses and has no template-breaking sequences', () => {
  assert.doesNotThrow(() => new Function(RUNTIME_SOURCE));
  assert.ok(!RUNTIME_SOURCE.includes('`'));
});

test('version constant matches package.json', () => {
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, VERSION);
});
