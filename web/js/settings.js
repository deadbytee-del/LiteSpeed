// Lazy-loaded settings dialog.
import { SEARCH_ENGINES } from './url.js';
import { normalizeApiUrl, health } from './api.js';

export function openSettings(dialog, settings, { onSave, onClearHistory }) {
  dialog.innerHTML = `
  <form id="settings-form">
    <h3 id="settings-h">Settings</h3>
    <label class="field"><span>API endpoint</span>
      <div class="row"><input type="text" name="apiUrl" placeholder="Auto-detect" spellcheck="false" autocapitalize="off" inputmode="url"><button type="button" class="btn" id="test-api">Test</button></div>
      <small id="test-result">Leave empty to auto-detect (config.json, same origin, localhost).</small></label>
    <label class="field"><span>Search engine</span>
      <select name="search">${Object.entries(SEARCH_ENGINES).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}<option value="custom">Custom…</option></select></label>
    <label class="field" id="custom-field" hidden><span>Custom search URL</span><input type="text" name="searchCustom" placeholder="https://example.com/?q=%s" spellcheck="false"></label>
    <label class="field"><span>Open pages</span>
      <select name="openMode"><option value="embed">In this window (embedded frame)</option><option value="tab">In a new tab (full page, no toolbar)</option></select>
      <small>Embedded mode keeps the toolbar. Some browsers restrict cookies in embedded frames; new-tab mode avoids that.</small></label>
    <div class="dlg-foot"><button type="button" class="btn" id="clear-hist">Clear history</button><span><button type="button" class="btn" id="cancel">Cancel</button> <button type="submit" class="btn primary">Save</button></span></div>
  </form>`;
  const f = dialog.querySelector('form');
  for (const [k, v] of Object.entries(settings)) if (f.elements[k]) f.elements[k].value = v;
  const custom = dialog.querySelector('#custom-field');
  const sync = () => { custom.hidden = f.elements.search.value !== 'custom'; };
  f.elements.search.addEventListener('change', sync); sync();

  dialog.querySelector('#test-api').onclick = async () => {
    const out = dialog.querySelector('#test-result');
    const url = normalizeApiUrl(f.elements.apiUrl.value);
    if (!url) { out.textContent = 'Enter a URL to test.'; return; }
    out.textContent = 'Testing…';
    const r = await health(url);
    out.textContent = r.ok ? `OK · ${Math.round(r.ms)} ms · ${r.data.runtime} · v${r.data.version}` : `Failed: ${r.error}`;
  };
  dialog.querySelector('#clear-hist').onclick = () => { onClearHistory(); dialog.querySelector('#clear-hist').textContent = 'Cleared'; };
  dialog.querySelector('#cancel').onclick = () => dialog.close();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    onSave({ apiUrl: normalizeApiUrl(f.elements.apiUrl.value), search: f.elements.search.value, searchCustom: f.elements.searchCustom.value.trim(), openMode: f.elements.openMode.value });
    dialog.close();
  });
  dialog.showModal();
}
