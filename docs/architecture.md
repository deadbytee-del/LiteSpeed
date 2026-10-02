# Architecture

LiteSpeed is one proxy engine with two homes: the **service worker** (default) and the **server**. Everything that understands web content is shared; the backend can be reduced to a byte relay.

```
                         ┌───────────────────────── browser ─────────────────────────┐
 shell (web/js) ──────▶  │ iframe /scope/p/{key}/…  ──fetch──▶  service worker        │
                         │                                      ├ adblock.check        │
                         │                                      ├ ProxyEngine.handle   │
                         │                                      │   cookie jar (IDB)   │
                         │                                      │   cache (CacheStorage)│
                         │                                      │   rewriters (html/css/js)
                         │                                      └ BareTransport ───────┼──▶ relay /bare/v3/
                         └────────────────────────────────────────────────────────────┘        │ fetch upstream
                                                                                                 ▼ (undici pool, DNS cache)
 server mode:  browser ──▶ /p/{key}/… ──▶ createApp ──▶ same ProxyEngine ──▶ NodeTransport/FetchTransport ──▶ upstream
```

## Request path (`ProxyEngine.handle`)

1. Work out the resource type (`request.destination` in the SW, `Sec-Fetch-Dest` on the server) and whether to inject the runtime.
2. **Ad block**: `FilterEngine.check({url, type, pageUrl})`; blocked requests get a typed stand-in and never leave.
3. Build upstream headers; with a jar, attach its `Cookie`. Referer/Origin are translated back to upstream terms.
4. Cache lookup (GET, no cookie/authorization/range).
5. `transport.request(...)`: manual redirects, header-phase timeout.
6. Cookies: into the jar (SW) or rewritten `Set-Cookie` (server). `Location` is rewritten.
7. Pick a rewriter by content type and `pipeThrough` it (HTML streams; CSS/JS buffer). Inject runtime tag + cosmetic CSS.
8. Tee into the cache if eligible. Return `Response` with `Server-Timing` and `X-LiteSpeed-*`.

## Modules

| Concern | Module | Extension point |
|---|---|---|
| Frontend / UI | `web/` | – |
| In-page client | `src/runtime/client.js` | Add hooks. It is a template string (bundles anywhere): no backticks, no `${` |
| Service worker | `src/sw/sw.js` (+`bare-transport.js`, `idb.js`) | Bundled to `web/sw.js` by `scripts/build-sw.mjs` |
| Request/response processing | `src/engine/proxy-engine.js` | Pass your own `engine` to `createApp` |
| Resource rewriting | `src/rewrite/*`, `src/engine/rewriters.js` | `{ name, test(ct, {dest}), create(ctx) → TransformStream, contentType() }` |
| URL rewriting | `src/url/codec.js` | – |
| Cookies | `src/cookie-jar.js` (SW), `src/cookies.js` (server) | Jar takes any async `{load, save}` store |
| Cache | `src/cache/*` | Any `{ get(key), set(key, {status, headers, body, ttl}) }` |
| Transport | `src/transport/fetch.js`, `src/adapters/node-transport.js`, `src/sw/bare-transport.js` | Any `{ request({url, method, headers, body, signal}) → {status, statusText, headers, body, setCookies?} }` that does not follow redirects |
| Relay protocol | `src/bare.js` | Bare v3 |
| Ad blocker | `src/adblock/*` | `FilterEngine.add(listText)` |
| Load control | `src/limits.js`, `src/server.js` | – |
| Configuration | `src/config.js` | Env/bindings → plain object |
| Errors | `src/errors.js`, `src/pages.js` | `ProxyError(status, code, message)` |

## Why these choices

- **Origin in the path.** Relative URLs resolve natively; the SW and runtime can tell which site a request belongs to; storage and cookies can be namespaced per site.
- **Rewrite in the browser.** The relay does no parsing, so its cost per request is a small constant and capacity scales with clients. Measured: relay 2,195 req/s vs server rewrite 345 req/s per worker on the same machine (`npm run loadtest`).
- **Token-level JS rewriting.** A full AST pass is slow and the usual source of breakage. The tokenizer finds the few identifiers that expose the proxy; each replacement is valid in every position it is applied to, and the helper wrappers return non-`Location` values unchanged so shadowed names still work. Parse failure ⇒ original source.
- **Bare v3 on the wire.** Interoperable; a constant endpoint means one CORS preflight, cached for a day.
- **Jar in the SW.** A synthesised `Response` cannot set cookies and the SW cannot read them, so cookies must be modelled explicitly.
- **Header-phase timeout.** Large downloads and streams are never cut by the request timeout.
- **Allow-listed response headers.** Unknown upstream headers can't change the proxy origin's security posture; CSP/XFO/HSTS/COOP/COEP/CORP are deliberately removed so pages can run in a frame.
- **Connect-time address check (Node).** The dialled IP is validated in the DNS lookup used by the connection, so there is no gap between check and use.

## Adding a platform

Write an adapter that converts the platform request into a `Request`, calls `app.fetch(request, env, ctx)`, and writes the `Response` back (`src/adapters/node.js` is the full version, `cloudflare.js` the short one). Provide a transport appropriate to the platform.

## Adding a transport

Implement `request()` (see table). Examples: a relay chain through another LiteSpeed instance, an egress-proxy transport, a test double. The service worker's `BareTransport` accepts several relay URLs and handles host affinity, retry and failover.
