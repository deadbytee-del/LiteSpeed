import { createApp } from '../index.js';
import { CacheApiCache } from '../cache/cache-api.js';

let app;

export default {
  fetch(request, env, ctx) {
    app ??= createApp({ env, runtime: 'cloudflare-workers', cache: new CacheApiCache(caches.default) });
    return app.fetch(request, env, ctx);
  },
};
