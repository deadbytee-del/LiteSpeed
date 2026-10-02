const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const flag = (v, dflt) => (v == null || v === '' ? dflt : /^(1|on|true|yes)$/i.test(String(v)));
const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

export const DEFAULTS = Object.freeze({
  basePath: '',
  allowedOrigins: ['*'],
  timeoutMs: 20000,
  cache: true,
  cacheMaxEntries: 300,
  cacheMaxBytes: 32 * 1024 * 1024,
  cacheMaxItemBytes: 2 * 1024 * 1024,
  cacheMaxTtl: 3600,
  rewriteJs: false,
  blockedHosts: [],
  allowedHosts: [],
  allowPrivate: false,
  userAgent: '',
});

/** Build a config object from a flat env-like record (process.env, Workers bindings). */
export function loadConfig(env = {}, overrides = {}) {
  const origins = list(env.LITESPEED_ALLOWED_ORIGINS);
  return {
    ...DEFAULTS,
    basePath: String(env.LITESPEED_BASE_PATH || '').replace(/\/+$/, ''),
    allowedOrigins: origins.length ? origins : DEFAULTS.allowedOrigins,
    timeoutMs: num(env.LITESPEED_TIMEOUT_MS, DEFAULTS.timeoutMs),
    cache: flag(env.LITESPEED_CACHE, DEFAULTS.cache),
    rewriteJs: flag(env.LITESPEED_REWRITE_JS, DEFAULTS.rewriteJs),
    blockedHosts: list(env.LITESPEED_BLOCKED_HOSTS),
    allowedHosts: list(env.LITESPEED_ALLOWED_HOSTS),
    allowPrivate: flag(env.LITESPEED_ALLOW_PRIVATE, DEFAULTS.allowPrivate),
    userAgent: env.LITESPEED_USER_AGENT || '',
    ...overrides,
  };
}
