import test from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonKeys, isYoutubeHost, isYoutubeApiPath } from '../src/adblock/json-prune.js';
import { ProxyEngine } from '../src/engine/proxy-engine.js';
import { loadConfig } from '../src/config.js';
import { createAdblock } from '../src/adblock/index.js';
import { encodeOrigin } from '../src/url/codec.js';

const strip = (o, keys) => JSON.parse(stripJsonKeys(JSON.stringify(o), keys));

test('removes ad fields at any depth and leaves valid JSON', () => {
  const resp = { responseContext: { x: 1 }, videoDetails: { title: 'adPlacements are fun' }, adPlacements: [{ adPlacementRenderer: { config: { a: '}]"' } } }], playerAds: [{ q: [1, 2, { z: '\\"' }] }], streamingData: { formats: [] }, nested: { adSlots: [1], keep: true }, adBreakHeartbeatParams: 'abc' };
  assert.deepEqual(strip(resp), { responseContext: { x: 1 }, videoDetails: { title: 'adPlacements are fun' }, streamingData: { formats: [] }, nested: { keep: true } });
});

test('handles first/last/only keys, pretty-printing and strings that merely contain the key', () => {
  assert.equal(stripJsonKeys('{"adPlacements":[1]}'), '{}');
  assert.equal(stripJsonKeys('{"a":1,"adPlacements":[1,2]}'), '{"a":1}');
  assert.equal(stripJsonKeys('{ "adPlacements" : [ 1 ] , "a" : 1 }'), '{  "a" : 1 }');
  const trap = '{"msg":"he said \\"adPlacements\\":[1] ok","adSlots":null}';
  assert.deepEqual(JSON.parse(stripJsonKeys(trap)), { msg: 'he said "adPlacements":[1] ok' });
  assert.equal(stripJsonKeys('{"a":1}'), '{"a":1}');
  assert.equal(stripJsonKeys('{"adPlacements":[1,2'), '{"adPlacements":[1,2'); // truncated: untouched
});

test('works on an inline script assignment', () => {
  const player = JSON.stringify({ videoDetails: { videoId: 'x' }, adPlacements: [{ a: 1 }], playerAds: [{ b: 2 }] });
  const out = stripJsonKeys(`var ytInitialPlayerResponse = ${player};var meta = 1;`);
  assert.equal(out, `var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { videoId: 'x' } })};var meta = 1;`);
});

test('host and path matching', () => {
  assert.ok(isYoutubeHost('www.youtube.com') && isYoutubeHost('youtube.com') && isYoutubeHost('music.youtube.com') && !isYoutubeHost('notyoutube.com') && !isYoutubeHost('youtube.com.evil.test'));
  assert.ok(isYoutubeApiPath('/youtubei/v1/player') && isYoutubeApiPath('/youtubei/v1/next') && !isYoutubeApiPath('/youtubei/v1/log_event'));
});

test('engine prunes YouTube player JSON and inline player response; other hosts are untouched; disabled with the ad blocker', async () => {
  const player = JSON.stringify({ videoDetails: { videoId: 'v' }, adPlacements: [{ x: 1 }], streamingData: {} });
  const transport = {
    async request({ url }) {
      const u = new URL(url);
      if (u.pathname === '/watch') return { status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'text/html' }), body: new Response(`<html><head></head><body><script>var ytInitialPlayerResponse = ${player};</script></body></html>`).body };
      return { status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }), body: new Response(player).body };
    },
  };
  const run = async (origin, path, config = {}) => {
    const cfg = loadConfig({}, { cache: false, ...config });
    const engine = new ProxyEngine({ config: cfg, transport, adblock: createAdblock() });
    const url = new URL(origin + path);
    const res = await engine.handle(new Request('http://p/x', { headers: { 'sec-fetch-dest': path === '/watch' ? 'document' : 'empty' } }), { key: encodeOrigin(origin), url }, {});
    return res.text();
  };
  assert.doesNotMatch(await run('https://www.youtube.com', '/youtubei/v1/player'), /adPlacements/);
  assert.match(await run('https://www.youtube.com', '/youtubei/v1/player'), /videoDetails/);
  assert.doesNotMatch(await run('https://www.youtube.com', '/watch'), /adPlacements/);
  assert.match(await run('https://www.youtube.com', '/watch'), /ytInitialPlayerResponse = \{"videoDetails":\{"videoId":"v"\},"streamingData":\{\}\};/);
  assert.match(await run('https://example.com', '/youtubei/v1/player'), /adPlacements/);
  assert.match(await run('https://www.youtube.com', '/youtubei/v1/player', { adblock: false }), /adPlacements/);
});
