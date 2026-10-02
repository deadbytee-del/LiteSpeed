// Lazy-loaded settings dialog.
import { SEARCH_ENGINES } from './url.js';
import { normalizeApiUrl, health } from './api.js';
import { clearSwCookies } from './sw-client.js';

export function openSettings(dialog, settings, { onSave, onClearHistory, onUpdateLists, sw }) {
  dialog.innerHTML = `
  <form id="settings-form">
    <h3 id="settings-h">Settings</h3>
    <label class="field"><span>Relay / API endpoint</span>
      <div class="row"><input type="text" name="apiUrl" placeholder="Auto-detect" spellcheck="false" autocapitalize="off" inputmode="url"><button type="button" class="btn" id="test-api">Test</button></div>
      <small id="test-result">Leave empty to auto-detect. Several endpoints can be comma-separated for failover.</small></label>
    <label class="field"><span>Proxy mode</span>
      <select name="mode"><option value="auto">Automatic (service worker when available)</option><option value="sw">Service worker: rewriting runs in this browser</option><option value="server">Server rewriting (no service worker)</option></select></label>
    <fieldset class="checks"><legend>Ad blocker</legend>
      <label><input type="checkbox" name="adblock"> Block ads and trackers</label>
      <label><input type="checkbox" name="popups"> Block pop-ups opened without a click</label>
      <label><input type="checkbox" name="easylist"> Also load EasyList <small>(~1 MB, fetched through the relay, then cached)</small></label>
      <div class="row" style="margin-top:6px"><button type="button" class="btn" id="upd-lists">Update lists now</button><span id="lists-result" class="muted"></span></div>
    </fieldset>
    <label class="field"><span>Search engine</span>
      <select name="search">${Object.entries(SEARCH_ENGINES).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}<option value="custom">Custom…</option></select></label>
    <label class="field" id="custom-field" hidden><span>Custom search URL</span><input type="text" name="searchCustom" placeholder="https://example.com/?q=%s" spellcheck="false"></label>
    <label class="field"><span>Open pages</span>
      <select name="openMode"><option value="embed">In this window (embedded frame)</option><option value="tab">In a new tab (full page, no toolbar)</option></select>
      <small>Embedded mode keeps the toolbar. Some browsers restrict cookies in embedded frames; new-tab mode avoids that.</small></label>
    <div class="dlg-foot"><span><button type="button" class="btn" id="clear-hist">Clear history</button> <button type="button" class="btn" id="clear-ck">Clear site cookies</button></span><span><button type="button" class="btn" id="cancel">Cancel</button> <button type="submit" class="btn primary">Save</button></span></div>
  </form>`;
  const f = dialog.querySelector('form');
  for (const [k, v] of Object.entries(settings)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
  const custom = dialog.querySelector('#custom-field');
  const sync = () => { custom.hidden = f.elements.search.value !== 'custom'; };
  f.elements.search.addEventListener('change', sync); sync();

  dialog.querySelector('#test-api').onclick = async () => {
    const out = dialog.querySelector('#test-result');
    const url = normalizeApiUrl(f.elements.apiUrl.value.split(',')[0]);
    if (!url) { out.textContent = 'Enter a URL to test.'; return; }
    out.textContent = 'Testing…';
    const r = await health(url);
    out.textContent = r.ok ? `OK · ${Math.round(r.ms)} ms · ${r.data.runtime} · v${r.data.version}` : `Failed: ${r.error}`;
  };
  dialog.querySelector('#clear-hist').onclick = () => { onClearHistory(); dialog.querySelector('#clear-hist').textContent = 'Cleared'; };
  dialog.querySelector('#upd-lists').onclick = async () => {
    const out = dialog.querySelector('#lists-result');
    out.textContent = 'Updating…';
    const next = { ...settings, easylist: f.elements.easylist.checked, adblock: f.elements.adblock.checked };
    onSave(next);
    const lists = await onUpdateLists();
    out.textContent = lists.length ? lists.map((l) => (l.ok ? `${l.rules.toLocaleString()} lines` : `failed: ${l.error}`)).join(', ') : 'Nothing to download (EasyList is off, or no service worker).';
  };
  dialog.querySelector('#clear-ck').onclick = async () => {
    const reg = sw?.()?.reg;
    if (reg) await clearSwCookies(reg);
    dialog.querySelector('#clear-ck').textContent = reg ? 'Cleared' : 'Not applicable';
  };
  dialog.querySelector('#cancel').onclick = () => dialog.close();
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    onSave({
      apiUrl: f.elements.apiUrl.value.split(',').map(normalizeApiUrl).filter(Boolean).join(','),
      search: f.elements.search.value, searchCustom: f.elements.searchCustom.value.trim(), openMode: f.elements.openMode.value,
      mode: f.elements.mode.value, adblock: f.elements.adblock.checked, popups: f.elements.popups.checked, easylist: f.elements.easylist.checked,
    });
    dialog.close();
  });
  dialog.showModal();
}
