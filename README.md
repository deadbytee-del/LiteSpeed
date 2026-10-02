# LiteSpeed

A fast, lightweight web proxy in the style of Ultraviolet and Scramjet: a **service worker** rewrites pages in your browser, and a small **relay server** (your own, on your machine or any host) only moves bytes. The whole front end is static, so it runs on GitHub Pages.

```
 Browser ── GitHub Pages ── web/  UI + sw.js (the proxy engine, running in your browser)
    │                           │ every proxied request is intercepted here: rewrite, cookies, ad-block, cache
    │                           ▼
    └──────── HTTPS ───────  relay  (Node, Docker or Cloudflare Workers)
                              ├─ /bare/v3/   Bare v3 relay: fetch the real site, return status/headers/body
                              ├─ /api/ws     WebSocket relay (Node)
                              ├─ /api/*      health, info, resolve, ping, docs
                              └─ /p/…        optional server-side rewrite mode (no service worker needed)
```

**Two modes, one engine.** The same `ProxyEngine` (`src/engine/`) runs in the service worker (default, "static proxy") and on the server ("server rewrite", the fallback for browsers where service workers are unavailable). In service-worker mode the relay does no parsing at all, which is why it costs ~6× less CPU per request (measured below) and scales with the number of *clients*, not with your server.

GitHub Pages cannot proxy anything by itself. Without a relay it is an honestly-labelled static demo; with one it is the full proxy.

## Quick start (everything on your machine)

Node ≥ 20.

```bash
npm install
npm start            # http://127.0.0.1:8787: frontend + relay on one origin
```

Open <http://127.0.0.1:8787> and type `example.com`. The pill should read **Static proxy** (service-worker mode). The strip under the page shows real `Server-Timing` numbers, and the shield shows how many ads/trackers were blocked.

`npm start` runs one worker per CPU (max 4). `LITESPEED_ALLOW_PRIVATE=on npm start` additionally lets you proxy things on your own machine (refused by default).

## Run the relay yourself and use the GitHub Pages site

This is the "own server" setup: the static site on Pages, the relay on your machine (loopback) or a VPS.

1. Start the relay: `npm start` (or Docker, below). It listens on `http://127.0.0.1:8787`.
2. Open your Pages site → **Settings → Relay / API endpoint** → `http://localhost:8787` → Save. (Or visit `https://<user>.github.io/LiteSpeed/?api=http://localhost:8787` once.)
3. Browsers allow an HTTPS page to call `http://localhost`; the relay answers Chrome's Private Network Access preflight. Set `LITESPEED_ALLOWED_ORIGINS=https://<user>.github.io` so only your site can use it.

For a remote relay, put it behind TLS (Caddy/nginx/Cloudflare) or give it a certificate (HTTP/2, below).

## Deploy

### Frontend: GitHub Pages

Either works:

- **Deploy from a branch** (Settings → Pages → `main` / root): nothing to build. `web/sw.js` is committed; the root `index.html` forwards to `web/`. Set the relay in the UI (Settings → endpoint) or with `?api=`.
- **GitHub Actions** (recommended, Settings → Pages → Source: GitHub Actions): set repo variable `LITESPEED_API_URL` (one URL, or several comma-separated for failover). The workflow builds `dist/` with that URL baked into `config.json`.

If you change anything under `src/` that the service worker uses, run `npm run build:sw` and commit `web/sw.js` (a test fails if it is stale).

### Relay

| Where | How |
|---|---|
| **Node / VPS** | `HOST=0.0.0.0 LITESPEED_ALLOWED_ORIGINS=https://<user>.github.io npm start` |
| **Docker** | `docker build -t litespeed . && docker run -p 8787:8787 -e LITESPEED_ALLOWED_ORIGINS=https://<user>.github.io litespeed` |
| **Cloudflare Workers** | `npm install && npx wrangler login && npm run deploy:worker` (edit `wrangler.toml` first). Gives you HTTP/2, HTTP/3 and the edge's concurrency for free. No WebSocket relay or server-side DNS pinning on Workers. |

**HTTP/2 matters.** In service-worker mode every sub-resource of a page is a request to the relay origin, and HTTP/1.1 caps browsers at 6 connections per origin. Measured on this repo (`npm run bench:h2`, 150 images × 80 ms upstream, loopback): **2,337 ms over HTTP/1.1 vs 726 ms over HTTP/2**. Cloudflare and any modern reverse proxy give you h2; for a bare Node box set `LITESPEED_TLS_KEY`/`LITESPEED_TLS_CERT` and the server speaks h2 itself (HTTP/1.1 and WebSockets still work on the same port).

## Ad blocker

On by default (shield button in the toolbar; Settings for options).

- **Network blocking** happens before a request leaves the browser (service-worker mode) or the server (server mode): ad/tracker requests never reach the relay, so pages load less and your relay carries less. Blocked requests get a typed stand-in (empty script/CSS, 1×1 GIF, blank iframe, 204) so pages don't break.
- **Cosmetic hiding** injects one stylesheet of ad-container selectors.
- **Pop-ups** opened without a user gesture are blocked.
- **Filter engine** (`src/adblock/engine.js`) understands Adblock Plus / uBlock syntax: `||domain^`, anchors, `*`, `^`, `@@` exceptions, `$script,image,…`, `$third-party`, `$domain=`, `##selector`, `#@#`. Rules it can't honour (`redirect=`, `removeparam=`, regex, procedural cosmetics) are skipped, not approximated. Pure-domain rules are a suffix lookup; the rest are token-indexed, so a 60,000-rule list costs well under 0.05 ms per request (tested).
- A compact starter list ships in the service worker. **Settings → "Also load EasyList"** downloads EasyList through the relay and caches it.
- Limits: first-party ads (e.g. YouTube video ads) need script-level blocking, which this doesn't do.

## Configuration

Environment variables (Node) or `[vars]` in `wrangler.toml`; see `.env.example`.

| Variable | Default | |
|---|---|---|
| `LITESPEED_ALLOWED_ORIGINS` | `*` | CORS allow-list. **Set to your Pages origin in production.** |
| `LITESPEED_ALLOWED_HOSTS` / `_BLOCKED_HOSTS` | empty | Host-suffix lists (allow list set ⇒ nothing else is proxied). |
| `LITESPEED_ALLOW_PRIVATE` | `off` | Allow loopback/private targets. Local development only. |
| `LITESPEED_TIMEOUT_MS` | `20000` | Wait for upstream response headers (bodies aren't cut off). |
| `LITESPEED_WORKERS` | `auto` | Cluster workers (`auto` = CPUs, max 4; `1` = off). |
| `LITESPEED_MAX_INFLIGHT` | `0` | Per-worker concurrent-request cap; excess gets an immediate `503 Retry-After`. |
| `LITESPEED_RATE_LIMIT` | `0` | Per-client requests/second; excess gets `429`. |
| `LITESPEED_TLS_KEY` / `_CERT` | empty | Serve HTTP/2 directly. |
| `LITESPEED_UPSTREAM_PROXY` | empty | Send outbound traffic through an HTTP(S) proxy. |
| `LITESPEED_TRUST_PROXY` | `off` | Honour `X-Forwarded-*` behind a reverse proxy. |
| `LITESPEED_ADBLOCK`, `_CACHE`, `_REWRITE_JS` | `on` | Server-mode features. |
| `LITESPEED_API_URL` | empty | **Build time**: relay URL(s) written to `dist/config.json`. |

Full endpoint reference: the `/api` page of the frontend ([`web/api/index.html`](web/api/index.html)).

## How it works

- **URL scheme** `/p/{base64url(origin)}{path}{?query}` under the scope (`/LiteSpeed/p/…` on Pages). The upstream origin is in the first path segment, so relative URLs resolve with no rewriting, and requests can be attributed to a site.
- **Service worker** (`src/sw/sw.js` → `web/sw.js`, ~180 KB with the engine, rewriters, ad blocker and runtime): intercepts requests under the prefix, applies ad-block rules, runs the engine, and answers from there. Settings and the cookie jar live in IndexedDB; responses are cached in CacheStorage with enforced expiry and a size bound.
- **Transport** (`src/sw/bare-transport.js`): each request becomes a Bare v3 call (`X-Bare-URL`, `X-Bare-Headers`) to the relay, with retries on 502/503, per-host relay affinity and failover across several relays. Any Bare v3 server also works as a relay, and LiteSpeed's relay works for other Bare clients.
- **HTML** is rewritten in one streaming pass: URL attributes, `srcset`, inline `style`/`<style>`, `<base>`, meta refresh; `integrity` and CSP meta removed; inline scripts go through the JS rewriter. **CSS** is rewritten for `url()`/`@import`. Other types stream untouched.
- **JavaScript** is rewritten at token level (acorn tokenizer, no AST, ~20 MB/s) in a handful of places only: `location` → virtual location (so SPAs see the real URL), `top`/`parent` → the proxied window (so frame-busters stay inside), `x.postMessage(…)` → origin-agnostic, absolute module specifiers → proxied. Parameters/variables named `location` keep working because the wrapper returns anything that isn't the real `Location` unchanged. Anything the tokenizer can't parse is passed through untouched. Workers get unmodified source.
- **Runtime** (`src/runtime/client.js`, injected first in `<head>`): hooks `fetch`, XHR, `EventSource`, `WebSocket` (via the relay), `history`, `window.open`, DOM URL properties, `innerHTML`/`insertAdjacentHTML`/`document.write`, cookies, `localStorage`/`sessionStorage`/IndexedDB (namespaced per site), `document.URL`/`domain`/`origin`, `MessageEvent.origin`; blocks service-worker registration; reports title/URL/timings to the toolbar.
- **Cookies** live in a real RFC 6265 jar in the service worker (domain/path/secure/expiry/`HttpOnly`, `__Host-`/`__Secure-` rules), because a synthesised response can't set browser cookies. `document.cookie` is a synchronous mirror kept fresh over a `BroadcastChannel`.
- **Frame isolation**: the shell sandboxes the iframe without `allow-top-navigation`; proxied pages see themselves as top-level.

Modularity: the engine takes a **transport** (`request(...) → {status, headers, body, setCookies}`), a **cache** (`get/set`), a **cookie jar**, an **adblock** engine and a list of **rewriters** (`{ name, test, create }`). Adapters (`src/adapters/`) only translate to/from the platform. See [`docs/architecture.md`](docs/architecture.md).

## Performance and load: measured, not claimed

Numbers below are from this repo's own scripts on the sandbox VM it was developed in (4 shared CPUs, Node 22, loopback). They show relative costs; run the scripts on your hardware.

| What | Result | Script |
|---|---|---|
| Relay overhead (service-worker mode) | **+1.6 ms** on a 198 KB page (rewriting happens in the browser) | `npm run bench` |
| Server HTML rewrite (198 KB, ~4,500 tags) | +12 ms | `npm run bench` |
| Server JS token rewrite (330 KB) | +27 ms | `npm run bench` |
| Cache hit | +0.6 ms | `npm run bench` |
| Relay vs server-rewrite capacity, 1 worker, 64 concurrent | **2,195 vs 345 req/s** | `npm run loadtest` |
| Server rewrite, 1 → 4 workers | 345 → 857 req/s | `npm run loadtest` |
| 150 images × 80 ms upstream via the SW: HTTP/1.1 vs HTTP/2 relay | **2,337 → 726 ms** | `npm run bench:h2` |
| 60,000-rule ad-block list | < 0.05 ms per lookup | `npm test` |

What makes it fast: rewriting on the client instead of your server; streaming HTML; cache (CacheStorage in the SW, LRU or Cache API on the server) for fresh public responses; ad/tracker requests never made; pooled keep-alive upstream connections (HTTP/2 where offered) with DNS caching; connection pre-warm while you type; HTTP/2 to the relay; cluster workers.

What makes it hold up under load: rewriting off the server (service-worker mode), cluster workers, `LITESPEED_MAX_INFLIGHT` / `LITESPEED_RATE_LIMIT` turning overload into immediate 503/429 (the service worker retries 503 on another relay), adaptive compression (skipped when close to the in-flight cap), no per-request server state. In a real deployment, network distance (browser → relay → site) dominates; nothing removes that.

Measure your deployment:

```bash
npm run bench                                           # proxy overhead, loopback
node scripts/bench.mjs --url https://example.com/ --api https://your-relay -n 40
node scripts/loadtest.mjs --api https://your-relay --url https://example.com/ -c 64 -d 10
npm run bench:h2                                        # needs playwright + chromium + openssl
```

## Testing

```bash
npm test                 # 69+ unit/integration tests: rewriters, JS rewrite validity, adblock, cookie jar, relay, WebSocket, limits, SW bundle freshness
npm run test:browser     # real Chromium: static Pages-style site + service worker + relay + a site with SPA routing,
                         # HttpOnly cookies, WebSocket, ads, redirects, forms, frame-busting (needs playwright)
npm run smoke            # loads real websites through the whole stack and reports (needs network + playwright)
```

Real sites checked with `npm run smoke` from the development sandbox: example.com, Wikipedia, Hacker News, DuckDuckGo (HTML), GitHub, MDN and BBC load and render; Reddit and Stack Overflow block the sandbox's egress IP regardless of LiteSpeed. Treat that as a smoke test, not a compatibility guarantee.

## Limitations (read before relying on it)

- Token-level JS rewriting covers location, top/parent, postMessage and module specifiers. It does not cover `eval`/`new Function` strings, `window['location']`, destructuring `location` out of `window`, or code that fingerprints the environment. Heavy SPAs may break; sites with bot protection (Cloudflare Turnstile, reCAPTCHA v3, device attestation) generally will.
- WebSockets work in service-worker mode through the Node relay only (not on Workers); WebRTC is not proxied. Service workers inside proxied pages are blocked.
- All proxied sites share the shell's real origin. Cookies, storage and IndexedDB are namespaced and the frame is sandboxed, but a hostile page that deliberately attacks the shell can't be fully contained; don't host anything sensitive on the same origin.
- Embedded mode needs same-site storage in iframes; if a browser blocks it, use **Settings → Open pages → new tab**.
- Service-worker mode needs HTTPS or localhost; otherwise the UI falls back to server rewriting.
- Requests from the relay carry the relay's TLS fingerprint and IP. Sites that block datacentre IPs or Node's TLS fingerprint will refuse them.

## Security notes

An open relay is abusable. Before exposing one: set `LITESPEED_ALLOWED_ORIGINS` to your Pages origin (and consider `LITESPEED_ALLOWED_HOSTS`); set `LITESPEED_RATE_LIMIT`/`LITESPEED_MAX_INFLIGHT`; keep `LITESPEED_ALLOW_PRIVATE` off. The target guard blocks non-http(s), loopback, link-local, private, CGNAT and internal-looking hosts; on Node the address that is actually dialled is checked at connect time (no DNS-rebinding gap), unless you route through `LITESPEED_UPSTREAM_PROXY`, in which case the proxy dials. Workers can't reach private networks by design. Check your host's acceptable-use policy for proxy services.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pill says **Static demo** | No relay found. Start one and set **Settings → Relay / API endpoint** (or `LITESPEED_API_URL` at build time). |
| Pill says **Backend offline** | The configured relay doesn't answer `/api/health`. `curl` it; `LITESPEED_ALLOWED_ORIGINS` must contain your Pages origin exactly (no trailing slash); Pages is HTTPS, so the relay must be HTTPS (except `http://localhost`). |
| Pill says **Connected** instead of **Static proxy** | Service worker unavailable (needs HTTPS/localhost) or disabled in Settings → Proxy mode. The Connection panel shows why. |
| Pages load slowly with many images | HTTP/1.1 relay: browsers allow 6 connections per origin. Use HTTP/2 (Cloudflare, a reverse proxy, or `LITESPEED_TLS_*`). |
| `403 private_target` | Intentional SSRF protection. Local development only: `LITESPEED_ALLOW_PRIVATE=on`. |
| `503 overloaded` / `429` | `LITESPEED_MAX_INFLIGHT` / `LITESPEED_RATE_LIMIT` tripped. Raise them or add relays (comma-separated). |
| `504 upstream_timeout` | Site slow or blocking the relay. Raise `LITESPEED_TIMEOUT_MS`. |
| Site returns 403 only through LiteSpeed | The site blocks the relay's IP/TLS fingerprint. Use a different relay location or `LITESPEED_UPSTREAM_PROXY`. |
| Blank page / script errors | The site needs JS features outside the rewriter's scope (see limitations). Check the console for `__ls$` errors and open an issue with the URL. |
| Changed `src/` but the site behaves as before | Rebuild the service worker: `npm run build:sw`, commit `web/sw.js`, and hard-reload once (Application → Service Workers → Update). |
| Ads still show | A first-party ad, or a rule isn't in the starter list: enable EasyList in Settings. |
| `/api` shows JSON on the relay host | Docs are served as HTML only when the browser asks for HTML and the frontend files sit next to the server (`web/` or `dist/`). |

## Project layout

```
web/                       static frontend (GitHub Pages)
  index.html css/ js/      shell: omnibox, history, settings (lazy), status, shield, progress
  sw.js                    GENERATED service worker bundle (npm run build:sw), committed so Pages needs no build
  api/index.html           API documentation page (live health check)
  demo/                    bundled static demo pages (clearly labelled, not proxied)
src/
  engine/                  ProxyEngine (pipeline) + rewriter registry
  rewrite/                 html.js (streaming), css.js, js.js (token rewriter), headers.js
  adblock/                 filter engine, starter list, blocked-response factory
  sw/                      service worker, Bare transport, IndexedDB helper
  runtime/client.js        injected in-page runtime
  bare.js                  Bare v3 relay handler
  index.js                 createApp(): router, CORS, errors, API endpoints
  cookie-jar.js cookies.js url/codec.js limits.js config.js errors.js pages.js
  cache/                   MemoryCache, CacheApiCache (Workers + service worker)
  security/guard.js        target policy (SSRF)
  adapters/                node.js (HTTP/2, compression, static, limits), node-transport.js (undici pool, DNS cache,
                           connect-time guard), ws-relay.js, cloudflare.js
  server.js                Node entry (cluster)
scripts/                   build-sw.mjs build-web.mjs bench.mjs loadtest.mjs h2-bench.mjs browser-test.mjs sites-smoke.mjs
test/                      node:test suites
```

## License

MIT
