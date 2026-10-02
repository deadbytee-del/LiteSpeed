import { rewriteUrl } from '../url/codec.js';

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const QUICK = /url\(|@import/i;

export function rewriteCss(css, base, basePath) {
  if (!QUICK.test(css)) return css;
  return css.replace(CSS_URL, (m, dq, sq, bare, idq, isq) => {
    const raw = dq ?? sq ?? bare ?? idq ?? isq;
    if (raw == null) return m;
    const out = rewriteUrl(raw, base, basePath);
    if (out === raw) return m;
    return m.startsWith('@') ? `@import "${out}"` : `url("${out}")`;
  });
}

/** Buffer a (small) text body, transform it once, emit UTF-8. */
export function bufferedTextTransform(fn, { charset = 'utf-8' } = {}) {
  let label = charset;
  try { new TextDecoder(label); } catch { label = 'utf-8'; }
  const decoder = new TextDecoder(label);
  const encoder = new TextEncoder();
  let text = '';
  return new TransformStream({
    transform(chunk) { text += decoder.decode(chunk, { stream: true }); },
    flush(controller) {
      text += decoder.decode();
      controller.enqueue(encoder.encode(fn(text)));
    },
  });
}
