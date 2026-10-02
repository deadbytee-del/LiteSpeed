// localStorage wrapper that degrades to memory when storage is unavailable.
const mem = new Map();
const get = (k) => { try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch { mem.set(k, v); } };
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

const SETTINGS_DEFAULTS = { apiUrl: '', search: 'ddg', searchCustom: '', openMode: 'embed' };
export const loadSettings = () => ({ ...SETTINGS_DEFAULTS, ...parse(get('ls.settings'), {}) });
export const saveSettings = (s) => set('ls.settings', JSON.stringify(s));

const MAX = 20;
export const loadHistory = () => parse(get('ls.history'), []);
export function addHistory(url, title) {
  const list = loadHistory().filter((h) => h.url !== url);
  list.unshift({ url, title: title || '', ts: Date.now() });
  set('ls.history', JSON.stringify(list.slice(0, MAX)));
}
export function removeHistory(url) { set('ls.history', JSON.stringify(loadHistory().filter((h) => h.url !== url))); }
export const clearHistory = () => set('ls.history', '[]');
