# Architecture

```
request ─▶ adapter ─▶ createApp().fetch ─▶ router ─┬─ /api/*  → JSON handlers
 (platform)  (node/workers)                         └─ /p/{key}/…
                                                         │ guard (checkTarget + hostCheck)
                                                         ▼
                                                    ProxyEngine.handle
                                                         │  1. build upstream headers
                                                         │  2. cache lookup (GET, no cookie/auth/range)
                                                         │  3. transport.request (manual redirects)
                                                         │  4. filter headers, rewrite Location + Set-Cookie
                                                         │  5. pick rewriter by content type → pipeThrough
                                                         │  6. tee into cache if eligible
                                                         ▼
                                                      Response (streamed)
```

| Concern | Module | Extension point |
|---|---|---|
| Frontend / UI | `web/` | – |
| Proxy client (in-page) | `src/runtime/client.js` | Add hooks; keep the "no backticks / `${`" rule (it is a template string so it bundles everywhere) |
| Request/response processing | `src/engine/proxy-engine.js` | Pass a custom `engine` to `createApp` |
| Resource rewriting | `src/rewrite/*`, `src/engine/rewriters.js` | Add `{ name, test(ct), create(ctx) → TransformStream, contentType() }` |
| URL rewriting | `src/url/codec.js` | – |
| Cookies/session | `src/cookies.js` | Stateless; swap for a server jar by changing `rewriteSetCookies` + header building |
| Cache | `src/cache/*` | Any `{ get(key), set(key, {status, headers, body, ttl}) }` |
| Transport | `src/transport/fetch.js` | Any `{ request({url, method, headers, body, signal}) → Response }` that does not follow redirects |
| Configuration | `src/config.js` | Env/bindings → plain object |
| Error handling | `src/errors.js`, `src/pages.js` | `ProxyError(status, code, message)` |

## Adding a proxy backend / transport

`createApp({ transport })` accepts any object implementing `request()`. Examples: a Node `undici` dispatcher with a custom agent, a relay that forwards through another LiteSpeed instance, or a test double. `createApp({ engine })` replaces the whole pipeline (e.g. an engine that renders through a headless browser) while keeping routing, CORS, health and errors.

## Adding a platform

Write an adapter that converts the platform request into a `Request`, calls `app.fetch(request, env, ctx)`, and writes the `Response` back (see `src/adapters/node.js` for the full version, `src/adapters/cloudflare.js` for the 6-line one). Pass `hostCheck` if the platform can resolve DNS and you want rebinding protection.

## Design decisions

- **Origin in the path, not a single encoded URL.** Relative URLs and cookie `Path` scoping work natively.
- **No JS rewriting.** It is the main source of breakage and CPU cost in other proxies; hooks cover the common dynamic cases, and the limits are documented.
- **Stateless.** No sessions, no sticky routing: it scales horizontally and runs on edge runtimes.
- **Header-phase timeout.** Large downloads and streams are never cut by the request timeout.
- **Allow-listed response headers.** Unknown upstream headers can't silently alter the proxy origin's security posture.
