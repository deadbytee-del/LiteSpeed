// API discovery and health checking.
export function normalizeApiUrl(v) {
  let s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|\[::1\])/.test(s) ? 'http://' : 'https://') + s;
  try { return new URL(s).origin + new URL(s).pathname.replace(/\/+$/, ''); } catch { return ''; }
}

export async function health(base, timeoutMs = 4000) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.name !== 'litespeed') return { ok: false, ms, error: 'Not a LiteSpeed endpoint' };
    return { ok: true, ms, data };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, error: e.name === 'TimeoutError' ? 'Timed out' : 'Unreachable (network or CORS)' };
  }
}

async function readConfig() {
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    return res.ok ? (await res.json()).apiUrl || '' : '';
  } catch { return ''; }
}

/**
 * Candidate order: ?api= query, saved setting, config.json (build-time
 * LITESPEED_API_URL), window.LITESPEED_API, same origin, localhost:8787.
 * All are probed in parallel; the highest-priority healthy one wins.
 */
export async function detectApi(settings) {
  const cands = [];
  const add = (url, source) => { url = normalizeApiUrl(url); if (url && !cands.some((c) => c.url === url)) cands.push({ url, source }); };
  add(new URLSearchParams(location.search).get('api'), 'query string');
  add(settings.apiUrl, 'settings');
  add(await readConfig(), 'config.json');
  add(window.LITESPEED_API, 'window.LITESPEED_API');
  if (!/\.github\.io$/i.test(location.hostname)) add(location.origin, 'same origin'); // Pages never hosts the API
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) add('http://localhost:8787', 'localhost default');

  const results = await Promise.all(cands.map((c) => health(c.url)));
  const i = results.findIndex((r) => r.ok);
  if (i >= 0) return { ...cands[i], health: results[i], ok: true };
  // Nothing healthy: surface the most deliberate candidate (not the same-origin probe) as "down".
  const explicit = cands.findIndex((c) => !['same origin', 'localhost default'].includes(c.source));
  return explicit >= 0 ? { ...cands[explicit], health: results[explicit], ok: false } : null;
}
