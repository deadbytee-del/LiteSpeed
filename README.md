# LiteSpeed

A small, fast web proxy with a browser-style interface.

- **Frontend** (`web/`): static HTML/CSS/ES modules, no build step, no framework. Deploys to GitHub Pages as-is.
- **Backend** (`src/`): one stateless `fetch(Request) → Response` handler with no platform dependencies. Adapters for **Node** (Docker, Fly, Render, a VPS…) and **Cloudflare Workers**.
- **No fake demo.** GitHub Pages cannot fetch or rewrite other sites, so the Pages build is split in two honest modes: with an API connected it is the full proxy; without one it is a clearly labelled static demo of the interface (bundled sample pages, health checking, error states) and refuses to pretend otherwise.

```
 Browser ── GitHub Pages ── web/ (UI, history, settings, health check, demo)
    │
    └──────── HTTPS ───────  API  (Node / Workers)
                              ├─ /api/*   health, info, resolve, go, ping, runtime.js
                              └─ /p/{key}/…  proxy → upstream site
```

## Quick start (local, one process)

Requires Node ≥ 20. No dependencies to install.

```bash
npm start            # http://127.0.0.1:8787  (frontend + API on one origin)
npm test             # 36 tests: codec, rewriters, guard, cookies, end-to-end
```

Open <http://127.0.0.1:8787>, type `example.com`, press Enter. The status pill shows the backend and its measured latency; the strip under the page shows the real `Server-Timing` of that navigation (upstream time, proxy overhead, rewrite type).

Private and loopback targets are refused by default. To proxy a site running on your own machine while developing, start with `LITESPEED_ALLOW_PRIVATE=on npm start`.

## Deploy

You deploy two things: the API (anywhere that can run it) and the frontend (GitHub Pages).

### 1. Backend

**Cloudflare Workers** (free tier works). The adapter was exercised locally under `wrangler dev` (real `workerd`: HTML/CSS rewriting, cookies, redirects, Cache API hits); it has not been load-tested on Cloudflare's network.

```bash
npm install
npx wrangler login
# edit wrangler.toml: set LITESPEED_ALLOWED_ORIGINS to your Pages origin, e.g. "https://<user>.github.io"
npm run deploy:worker
# → https://litespeed-api.<account>.workers.dev
curl https://litespeed-api.<account>.workers.dev/api/health
```

A manual GitHub Action (`deploy-worker.yml`) does the same with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets.

**Node / Docker**

```bash
docker build -t litespeed .
docker run -p 8787:8787 -e LITESPEED_ALLOWED_ORIGINS=https://<user>.github.io litespeed
# or, without Docker:
HOST=0.0.0.0 PORT=8787 LITESPEED_ALLOWED_ORIGINS=https://<user>.github.io npm start
```

Put it behind TLS (Caddy, nginx, your platform's edge) and set `LITESPEED_TRUST_PROXY=on` so it honours `X-Forwarded-Proto`. The Node adapter compresses text responses (Brotli/gzip) and resolves DNS to refuse names that point at private addresses.

### 2. Frontend on GitHub Pages

1. Repository **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: add `LITESPEED_API_URL` = your API URL (no trailing slash).
3. Push to `main` (or run the *Deploy frontend* workflow). The workflow runs `npm run build:web`, which copies `web/` to `dist/` and writes `config.json` with your API URL.

Without step 2 the site still works as the static demo. You can also connect later from **Settings → API endpoint**, or by visiting `https://<user>.github.io/LiteSpeed/?api=https://your-api` (not persisted; handy for testing).

**How the frontend finds the API.** In order, using the first candidate whose `/api/health` answers as LiteSpeed (all probed in parallel): `?api=` → saved setting → `config.json` → `window.LITESPEED_API` → same origin → `http://localhost:8787` (only when browsing from localhost).

### Build locally

```bash
LITESPEED_API_URL=https://your-api.example npm run build:web   # → dist/
```

## Configuration

Environment variables (Node) or `[vars]` in `wrangler.toml` (Workers):

| Variable | Default | |
|---|---|---|
| `LITESPEED_ALLOWED_ORIGINS` | `*` | CORS allow-list. **Set to your Pages origin in production.** |
| `LITESPEED_ALLOWED_HOSTS` / `LITESPEED_BLOCKED_HOSTS` | empty | Host-suffix lists. If the allow list is set, nothing else is proxied. |
| `LITESPEED_TIMEOUT_MS` | `20000` | Timeout until upstream response headers arrive (bodies are not cut off). |
| `LITESPEED_CACHE` | `on` | Response cache. |
| `LITESPEED_REWRITE_JS` | `off` | Rewrite absolute ES-module specifiers in scripts (buffers each script). |
| `LITESPEED_ALLOW_PRIVATE` | `off` | Allow loopback/private targets. Local development only. |
| `LITESPEED_BASE_PATH` | empty | Mount under a prefix. |
| `LITESPEED_TRUST_PROXY` | `off` | Node: trust `X-Forwarded-*`. |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Node listener (the Dockerfile sets `HOST=0.0.0.0`). |
| `LITESPEED_API_URL` | empty | **Build time**: written into `dist/config.json`. |

See `.env.example`. The full API reference is the `/api` page of the frontend ([`web/api/index.html`](web/api/index.html)); it also runs a live health check against whatever backend it detects.

## How it works

- **URL scheme** `/p/{base64url(origin)}{path}{?query}`. The upstream origin is in the first path segment, so relative URLs resolve correctly with no rewriting at all, and cookies and storage can be scoped per site.
- **HTML** is rewritten in a single streaming pass (`src/rewrite/html.js`): URL attributes, `srcset`, inline `style`, `<style>` blocks, `<base>`, meta-refresh; `integrity` and CSP meta are removed. Tags with nothing to rewrite are skipped cheaply; scripts pass through byte-for-byte. Output is identical regardless of chunk boundaries (tested). **CSS** is rewritten for `url()` and `@import`. Everything else streams untouched.
- **JavaScript is not rewritten.** A ~7 KB runtime (`/api/runtime.js`, injected first in `<head>`) hooks `fetch`, `XMLHttpRequest`, `EventSource`, `Worker`, `history`, `window.open`, DOM URL properties and `setAttribute`, `innerHTML`/`insertAdjacentHTML`/`document.write`, `document.cookie`, `localStorage`/`sessionStorage` (namespaced per site) and IndexedDB, and reports title/URL/timings to the toolbar. This keeps the server cheap and avoids the breakage that comes with JS source transforms; the trade-offs are listed below.
- **Redirects** are never followed server-side: the status is kept and `Location` rewritten, so cookies are applied at every hop.
- **Cookies** are stateless: upstream `Set-Cookie` becomes `Path=/p/{key}/; Secure; SameSite=None; Partitioned` on the API origin; the browser enforces the scoping.
- **Headers**: allow-list of response headers; CSP, `X-Frame-Options`, HSTS, COOP/COEP/CORP removed so pages can run in the frame; `Referer`/`Origin` translated back to upstream terms on the way out.
- **Cache**: in-memory LRU (Node) or Cache API (Workers), only for fresh, public, cookie-free `GET` 200s ≤ 2 MB. Rewritten output is what is cached, so repeat hits cost no parsing.
- **Streaming**: HTML and pass-through bodies are piped; the Node adapter compresses with a per-chunk flush so HTML stays progressive.
- **Frame isolation**: the shell sandboxes the iframe without `allow-top-navigation`, so frame-busting scripts cannot navigate the toolbar page away.

Modularity: the engine takes a **transport** (`src/transport/fetch.js`, anything with `request(...) → Response`), a **cache** (`get/set`), and a list of **rewriters** (`src/engine/rewriters.js`: `{ name, test, create }`). `createApp()` in `src/index.js` wires them; adapters in `src/adapters/` only translate to/from the platform. See [`docs/architecture.md`](docs/architecture.md).

## Performance testing

Nothing here quotes a speed-up figure. Measure on your own deployment:

```bash
# Proxy overhead in isolation (local upstream, loopback, no real network):
npm run bench

# Direct vs via-API against a real site, plus the API→upstream floor from /api/ping:
node scripts/bench.mjs --url https://example.com/ --api https://your-api.example -n 40
```

In the browser, the strip under a page shows `TTFB · upstream · proxy overhead · rewrite · load` taken from the navigation's `Server-Timing`; `X-LiteSpeed-Cache` shows `HIT/MISS/BYPASS` per resource in DevTools. The status pill shows the live `/api/health` round trip.

Sample `npm run bench` output (loopback on the sandbox VM this was developed in, Node 22, 198 KB HTML with ~4,500 tags; your numbers will differ):

```
added by proxy (p50 differences):
  HTML (rewritten, streamed)     +10.1 ms total
  CSS (rewritten, buffered)      +2.5 ms total
  4 MB binary (pass-through)     +6.0 ms total
  CSS with max-age (cache)       +0.5 ms total   (cache HIT)
```

On a real deployment, network distance (browser → API → site) dominates; no proxy removes that. Place the API close to your users or to the sites you use.

## Limitations (read before relying on it)

- No JS source rewriting: `location.href = "https://other.site"` and similar cannot be intercepted; pages reading `location.hostname` see the proxy host.
- No WebSockets (serverless runtimes can't hold them); service workers are blocked; Web Workers don't get the runtime.
- Sites with bot protection, IP-bound sessions or device attestation won't work.
- Embedded mode needs partitioned third-party cookies. If logins fail, use **Settings → Open pages → new tab**.
- Workers/edge CPU and response-size limits apply.
- Compatibility is "as good as hooks + HTML/CSS rewriting allow". Heavy SPAs may break; please open an issue with the URL.

## Security notes

An open proxy is abusable. Before exposing one publicly:

- Set `LITESPEED_ALLOWED_ORIGINS` to your Pages origin and consider `LITESPEED_ALLOWED_HOSTS`.
- The target guard blocks non-http(s), loopback, link-local, private, CGNAT and internal-looking hosts; the Node adapter also checks DNS results (a small time-of-check gap remains, so run it in a network with no internal reach). Workers can't reach private networks by design.
- All proxied sites share the API origin. The runtime namespaces cookies/storage/IndexedDB and the shell sandboxes the frame, but treat proxied content as untrusted and don't host anything sensitive on the same origin.
- Check your hosting provider's acceptable-use policy for proxy services.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Pill says **Static demo** | No API found. Set `LITESPEED_API_URL` (build) or **Settings → API endpoint**. |
| Pill says **Backend offline** | The configured API doesn't answer `/api/health`. `curl` it; check CORS (`LITESPEED_ALLOWED_ORIGINS` must include your Pages origin exactly, no trailing slash) and that it is HTTPS (Pages is HTTPS; browsers block mixed content, except `http://localhost`). |
| `403 private_target` | Intentional SSRF protection. Local dev only: `LITESPEED_ALLOW_PRIVATE=on`. |
| `504 upstream_timeout` | Upstream slow or blocking the host. Raise `LITESPEED_TIMEOUT_MS`. |
| Page loads but login doesn't stick | Third-party cookie restrictions in the iframe. Use new-tab mode. |
| Blank page, script errors | The site needs JS-level URL handling or WebSockets (see limitations). |
| Unstyled page / missing images | A resource escaped rewriting; the Referer fallback usually recovers it. Check DevTools for requests that aren't under `/p/`. |
| `/api` shows JSON instead of docs on the API host | Docs are served as HTML only when the browser asks for HTML and the frontend files are present (`web/` or `dist/` next to the server). |
| Workers: `wrangler` can't find the entry | Run from the repo root; `main` is `src/adapters/cloudflare.js`. |

## Project layout

```
web/                     static frontend (GitHub Pages)
  index.html css/ js/    shell: omnibox, history, settings (lazy), status, progress
  api/index.html         API documentation page (with live health check)
  demo/                  bundled static demo pages (clearly labelled, not proxied)
src/
  index.js               createApp(): router, CORS, errors, API endpoints
  engine/                ProxyEngine (request/response pipeline) + rewriter registry
  rewrite/               html.js (streaming), css.js, js.js (optional), headers.js
  url/codec.js           proxy URL scheme + URL rewriting
  cookies.js             Set-Cookie scoping
  cache/                 MemoryCache, CacheApiCache
  transport/fetch.js     transport (swap to change how upstreams are reached)
  security/guard.js      target policy (SSRF)
  runtime/client.js      injected client runtime
  adapters/              node.js (+static, compression, DNS check), cloudflare.js
  config.js errors.js pages.js version.js
scripts/                 build-web.mjs, bench.mjs
test/                    node:test suites (no dependencies)
```

## License

MIT
