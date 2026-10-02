const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Self-contained dark error page shown when a navigation fails. */
export function errorPage({ status, code, message, target }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status} · LiteSpeed</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0d;color:#e8e8ec;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{width:min(520px,calc(100% - 32px))}
.code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#a78bfa;letter-spacing:.04em}
h1{font-size:22px;font-weight:600;margin:6px 0 10px}
p{color:#9a9aa6;margin:0 0 18px}
.t{font:12px ui-monospace,monospace;color:#8a8a94;word-break:break-all;border:1px solid #26262c;border-radius:6px;padding:8px 10px;margin-bottom:18px}
button{background:#8b5cf6;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
</style></head><body><main>
<div class="code">${esc(status)} · ${esc(code)}</div>
<h1>${esc(message)}</h1>
${target ? `<div class="t">${esc(target)}</div>` : ''}
<button onclick="location.reload()">Try again</button>
</main></body></html>`;
}
