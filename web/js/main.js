import { loadSettings, saveSettings, loadHistory, addHistory, removeHistory, clearHistory } from './store.js';
import { detectApi, health } from './api.js';
import { normalizeInput, proxyUrl, hostOf, DEMO_PAGES } from './url.js';

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body, frame: $('frame'), view: $('view'), banner: $('banner'), err: $('err'), timing: $('timing'),
  barInput: $('bar-input'), homeInput: $('home-input'), pill: $('status-pill'), progress: $('progress'),
  recent: $('recent'), recentEmpty: $('recent-empty'), clearBtn: $('clear-history'), conn: $('conn'), note: $('mode-note'),
};

let settings = loadSettings();
let api = null; // { url, source, ok, health } | null
let current = null; // { kind: 'proxy' | 'demo', url }
let navStart = 0;
let readyTimer = 0;

/* ---------- status ---------- */
const state = () => (!api ? 'demo' : api.ok ? 'ok' : 'down');

function renderStatus(checking = false) {
  const s = checking ? 'checking' : state();
  el.pill.dataset.state = s;
  const label = { checking: 'Checking…', ok: `Connected · ${Math.round(api?.health?.ms ?? 0)} ms`, down: 'Backend offline', demo: 'Static demo' }[s];
  el.pill.querySelector('span').textContent = label;
  el.pill.title = api ? `${api.url} (${api.source})` : 'No proxy backend configured';

  const rows = [];
  const row = (k, v, cls = '') => rows.push(`<dt>${k}</dt><dd class="${cls}">${v}</dd>`);
  row('Mode', s === 'ok' ? 'Full proxy' : 'Static demo only', s === 'ok' ? 'ok' : 'warn');
  row('Endpoint', api ? api.url : 'not configured');
  row('Source', api ? api.source : '–');
  row('Health', api ? (api.ok ? 'OK' : `Failed: ${api.health.error}`) : '–', api ? (api.ok ? 'ok' : 'bad') : '');
  if (api?.ok) {
    row('Latency', `${api.health.ms.toFixed(0)} ms`);
    row('Runtime', api.health.data.runtime);
    row('Version', api.health.data.version);
  }
  row('Checked', new Date().toLocaleTimeString());
  el.conn.innerHTML = rows.join('');

  if (s === 'ok') el.note.textContent = `Pages are fetched through ${hostOf(api.url)}.`;
  else el.note.innerHTML = '<b>Static demo mode.</b> No proxy backend is connected, so real sites cannot be loaded. <a href="#" id="note-settings">Connect a backend</a> or <a href="demo/index.html" data-demo>open the demo</a>.';
}

async function refreshApi(showChecking = true) {
  if (showChecking) renderStatus(true);
  api = await detectApi(settings);
  renderStatus();
  return api;
}

/* ---------- progress ---------- */
let progTimer = 0;
function progressStart() {
  clearTimeout(progTimer);
  const bar = el.progress.firstElementChild;
  el.progress.classList.add('on');
  el.progress.setAttribute('aria-hidden', 'false');
  bar.style.width = '12%';
  let w = 12;
  const creep = () => { w += (88 - w) * 0.12; bar.style.width = w + '%'; progTimer = setTimeout(creep, 400); };
  progTimer = setTimeout(creep, 150);
}
function progressDone() {
  clearTimeout(progTimer);
  const bar = el.progress.firstElementChild;
  bar.style.width = '100%';
  progTimer = setTimeout(() => { el.progress.classList.remove('on'); el.progress.setAttribute('aria-hidden', 'true'); bar.style.width = '0'; }, 250);
}

/* ---------- views ---------- */
function showHome() {
  clearTimeout(readyTimer);
  progressDone();
  el.frame.src = 'about:blank';
  el.view.hidden = true;
  el.body.dataset.view = 'home';
  current = null;
  document.title = 'LiteSpeed';
  el.barInput.value = '';
  renderRecent();
  el.homeInput.focus();
}

function showBrowse() {
  el.view.hidden = false;
  el.body.dataset.view = 'browse';
}

function showError({ code, title, text, actions = [] }) {
  clearTimeout(readyTimer);
  progressDone();
  showBrowse();
  $('err-code').textContent = code;
  $('err-title').textContent = title;
  $('err-text').innerHTML = text;
  const box = $('err-actions');
  box.replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.onclick = a.run;
    return b;
  }));
  el.err.hidden = false;
  el.timing.hidden = true;
}

const hideError = () => { el.err.hidden = true; };

function setBanner(html) {
  el.banner.hidden = !html;
  if (html) el.banner.innerHTML = html;
}

/* ---------- navigation ---------- */
export async function go(input) {
  const r = normalizeInput(input, settings);
  if (!r) return;
  if (r.kind === 'demo') return openDemo(r.page);
  return openProxy(r.url);
}

function openDemo(page) {
  hideError();
  showBrowse();
  current = { kind: 'demo', url: `litespeed://${page}` };
  setBanner('<b>Static demo.</b> This page is bundled with the frontend. It is <u>not</u> being fetched through a proxy.');
  el.barInput.value = current.url;
  document.title = 'Demo – LiteSpeed';
  navStart = performance.now();
  progressStart();
  el.timing.hidden = true;
  el.frame.src = `demo/${DEMO_PAGES[page] || 'index'}.html`;
}

async function openProxy(url) {
  if (!api?.ok) await refreshApi();
  if (!api?.ok) {
    return showError({
      code: api ? 'backend_unreachable' : 'no_backend',
      title: api ? 'The proxy backend is not responding' : 'No proxy backend is connected',
      text: api
        ? `Could not reach <code>${api.url}</code> (${api.health.error}). GitHub Pages only serves the frontend; fetching other sites needs the API running.`
        : 'GitHub Pages can only serve static files, so fetching other sites needs the LiteSpeed API deployed somewhere that can run it. Set its URL in settings, or try the bundled demo.',
      actions: [
        { label: 'Open settings', primary: true, run: openSettings },
        { label: 'Retry', run: () => openProxy(url) },
        { label: 'Static demo', run: () => openDemo('demo') },
      ],
    });
  }
  let target;
  try { target = proxyUrl(api.url, url); } catch { return showError({ code: 'invalid_url', title: 'That address is not valid', text: `<code>${url.replace(/</g, '&lt;')}</code>` }); }

  current = { kind: 'proxy', url };
  el.barInput.value = url;
  if (settings.openMode === 'tab') {
    addHistory(url, '');
    window.open(target, '_blank', 'noopener');
    return renderRecent();
  }
  hideError();
  setBanner('');
  showBrowse();
  navStart = performance.now();
  progressStart();
  el.timing.hidden = true;
  el.frame.src = target;
  // Pages that carry the runtime say hello; if nothing does, check whether the backend died.
  clearTimeout(readyTimer);
  readyTimer = setTimeout(async () => {
    if (current?.kind !== 'proxy') return;
    const h = await health(api.url, 3000);
    if (!h.ok) { api = { ...api, ok: false, health: h }; renderStatus(); showError({ code: 'backend_unreachable', title: 'The proxy backend stopped responding', text: `${h.error}`, actions: [{ label: 'Retry', primary: true, run: () => openProxy(url) }] }); }
  }, 8000);
}

function cmd(c) {
  if (!current) return;
  if (current.kind === 'demo') {
    try { c === 'reload' ? el.frame.contentWindow.location.reload() : el.frame.contentWindow.history[c](); } catch { /* ignore */ }
    return;
  }
  if (c === 'reload' && !el.err.hidden) return openProxy(current.url);
  if (c === 'reload') { navStart = performance.now(); progressStart(); }
  try { el.frame.contentWindow.postMessage({ litespeed: 'cmd', cmd: c }, new URL(api.url).origin); } catch { /* ignore */ }
}

/* ---------- messages from the injected runtime ---------- */
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.source === el.frame.contentWindow && e.data?.litespeed === 'demo-nav') {
    current = { kind: 'demo', url: `litespeed://${e.data.page === 'index' ? 'demo' : e.data.page}` };
    el.barInput.value = current.url;
    return;
  }
  if (e.source !== el.frame.contentWindow || !e.data || !e.data.litespeed) return;
  if (!api || e.origin !== new URL(api.url).origin) return;
  const d = e.data;
  if (d.litespeed === 'ready') { clearTimeout(readyTimer); e.source.postMessage({ litespeed: 'hello' }, e.origin); return; }
  if (d.litespeed !== 'nav' || current?.kind !== 'proxy') return;
  current.url = d.url;
  el.barInput.value = d.url;
  document.title = `${d.title || hostOf(d.url)} – LiteSpeed`;
  addHistory(d.url, d.title);
  showTiming(d.timing);
});

function showTiming(t) {
  if (!t) return;
  const dur = (n) => (t.server.find((s) => s.name === n) || {}).dur;
  const parts = [];
  if (t.ttfb) parts.push(`TTFB ${t.ttfb} ms`);
  if (dur('upstream') != null) parts.push(`upstream ${Math.round(dur('upstream'))} ms`);
  if (dur('proxy') != null) parts.push(`proxy overhead ${dur('proxy').toFixed(1)} ms`);
  const rw = t.server.find((s) => s.name === 'rewrite');
  if (rw) parts.push(`rewrite: ${rw.desc}`);
  if (t.server.some((s) => s.name === 'cache')) parts.push('cache hit');
  if (t.load) parts.push(`load ${t.load} ms`);
  el.timing.textContent = parts.join(' · ');
  el.timing.hidden = !parts.length;
}

el.frame.addEventListener('load', () => {
  if (el.frame.src === 'about:blank' || !current) return;
  progressDone();
  if (current.kind === 'demo') {
    try { const d = el.frame.contentDocument; document.title = `${d.title} – LiteSpeed`; } catch { /* cross-origin */ }
  }
});

/* ---------- recent ---------- */
function renderRecent() {
  const list = loadHistory().slice(0, 8);
  el.recentEmpty.hidden = list.length > 0;
  el.clearBtn.hidden = list.length === 0;
  el.recent.replaceChildren(...list.map((h) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'item'; a.href = '#'; a.title = h.url;
    const host = hostOf(h.url);
    const letter = document.createElement('span'); letter.className = 'letter'; letter.textContent = host.replace(/^www\./, '')[0] || '?';
    const t = document.createElement('span'); t.className = 't';
    const title = document.createElement('span'); title.textContent = h.title || host;
    const small = document.createElement('small'); small.textContent = h.url.replace(/^https?:\/\//, '');
    t.append(title, small); a.append(letter, t);
    a.onclick = (ev) => { ev.preventDefault(); go(h.url); };
    const x = document.createElement('button'); x.className = 'x'; x.setAttribute('aria-label', `Remove ${host}`); x.textContent = '×';
    x.onclick = () => { removeHistory(h.url); renderRecent(); };
    li.append(a, x);
    return li;
  }));
}

/* ---------- settings (lazy) ---------- */
async function openSettings() {
  const { openSettings: open } = await import('./settings.js');
  open($('settings'), settings, {
    onSave: async (s) => { settings = s; saveSettings(s); await refreshApi(); },
    onClearHistory: () => { clearHistory(); renderRecent(); },
  });
}

/* ---------- wiring ---------- */
const submit = (input) => (e) => { e.preventDefault(); const v = input.value; if (input === el.homeInput) input.value = ''; go(v); input.blur?.(); };
$('home-form').addEventListener('submit', submit(el.homeInput));
$('bar-form').addEventListener('submit', submit(el.barInput));
$('brand').addEventListener('click', (e) => { e.preventDefault(); showHome(); });
$('back').onclick = () => cmd('back');
$('forward').onclick = () => cmd('forward');
$('reload').onclick = () => cmd('reload');
$('settings-btn').onclick = openSettings;
el.pill.onclick = () => (el.body.dataset.view === 'home' ? $('recheck').click() : showHome());
$('recheck').onclick = () => refreshApi();
el.clearBtn.onclick = () => { clearHistory(); renderRecent(); };
el.barInput.addEventListener('focus', () => el.barInput.select());
document.addEventListener('click', (e) => {
  const demo = e.target.closest('[data-demo]');
  if (demo) { e.preventDefault(); openDemo('demo'); }
  if (e.target.id === 'note-settings') { e.preventDefault(); openSettings(); }
});
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); (el.body.dataset.view === 'home' ? el.homeInput : el.barInput).focus(); }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); cmd('back'); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); cmd('forward'); }
  if (e.key === 'Escape' && el.body.dataset.view === 'browse' && document.activeElement === el.barInput) { el.barInput.value = current?.url || ''; el.barInput.blur(); }
});

renderRecent();
renderStatus(true);
refreshApi(false).then(() => {
  // Deep link: ?go=<address> opens it immediately once the API has been probed.
  const q = new URLSearchParams(location.search).get('go');
  if (q) go(q);
});
