// Registers the LiteSpeed service worker and delivers its configuration.
export const swSupported = () => 'serviceWorker' in navigator && window.isSecureContext;
export const basePath = () => new URL('./', location.href).pathname.replace(/\/$/, '');

export async function registerSw() {
  await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

function ask(reg, message, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('Service worker did not answer')), timeoutMs);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    (reg.active || navigator.serviceWorker.controller).postMessage(message, [ch.port2]);
  });
}

export const configureSw = (reg, config, refreshLists = false) => ask(reg, { ls: 'config', config, refreshLists }, refreshLists ? 60000 : 8000);
export const clearSwCookies = (reg) => ask(reg, { ls: 'clear-cookies' });
