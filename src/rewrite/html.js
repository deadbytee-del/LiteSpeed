import { rewriteUrl, toProxyPath } from '../url/codec.js';
import { rewriteCss } from './css.js';

const URL_ATTRS = new Set(['href', 'src', 'action', 'poster', 'data', 'formaction', 'cite', 'background', 'longdesc', 'manifest']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_END = /(?:[^>"']|"[^"]*"|'[^']*')*>/y;
const NAME = /^<([A-Za-z][^\s/>]*)/;
// Cheap pre-check: most tags carry nothing we rewrite, so skip attribute parsing for them.
const INTEREST = /(?:href|src|action|poster|data|formaction|cite|background|longdesc|manifest|srcset|style|integrity|target|content)\s*=|http-equiv/i;
const MAX_CARRY = 256 * 1024;
const TAIL = 16;

const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decodeEntities = (s) =>
  s.includes('&') ? s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt));/gi, (m, d, h, n) => (n ? ENT[n.toLowerCase()] : String.fromCodePoint(d ? +d : parseInt(h, 16)))) : s;
const encodeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function rewriteSrcset(value, base, basePath) {
  if (/^\s*data:/i.test(value)) return value;
  return value.replace(/(^|,)(\s*)([^\s,]+)/g, (m, sep, ws, url) => `${sep}${ws}${rewriteUrl(url, base, basePath)}`);
}

/**
 * Streaming HTML rewriter. A single forward scan over start tags: attributes are
 * edited in place, inline <style> is rewritten, scripts pass through untouched.
 * Incomplete tags at chunk boundaries are carried into the next chunk.
 */
export class HtmlRewriter {
  constructor({ base, basePath, runtimeSrc, inject = true }) {
    this.base = new URL(base);
    this.basePath = basePath;
    this.runtimeTag = inject && runtimeSrc ? `<script src="${runtimeSrc}"></script>` : '';
    this.injected = !this.runtimeTag;
    this.carry = '';
    this.raw = null; // { name, re, buffered }
    this.styleBuf = '';
  }

  process(text, final = false) {
    let s = this.carry + text;
    this.carry = '';
    let out = '';
    let i = 0;
    const n = s.length;

    while (i < n) {
      if (this.raw) {
        const { re, buffered } = this.raw;
        re.lastIndex = i;
        const m = re.exec(s);
        if (m) {
          const body = s.slice(i, m.index);
          out += buffered ? this.endStyle(body) : body;
          this.raw = null;
          i = m.index;
          continue;
        }
        if (final) {
          const body = s.slice(i);
          out += buffered ? this.endStyle(body) : body;
          this.raw = null;
          i = n;
        } else {
          // Hold back a short tail: it may be the start of a split closing tag.
          const keep = Math.max(i, n - TAIL);
          if (buffered) this.styleBuf += s.slice(i, keep); else out += s.slice(i, keep);
          this.carry = s.slice(keep);
          i = n;
        }
        break;
      }

      const lt = s.indexOf('<', i);
      if (lt === -1) { out += s.slice(i); i = n; break; }
      out += s.slice(i, lt);
      i = lt;

      if (n - i < 4 && !final) { this.carry = s.slice(i); i = n; break; }
      const c = s[i + 1];
      let end = -1;
      let kind;

      if (s.startsWith('<!--', i)) { end = s.indexOf('-->', i + 4); end = end < 0 ? -1 : end + 2; kind = 'pass'; }
      else if (c === '!' || c === '?' || c === '/') { end = s.indexOf('>', i); kind = 'pass'; }
      else if (/[A-Za-z]/.test(c)) { TAG_END.lastIndex = i; end = TAG_END.test(s) ? TAG_END.lastIndex - 1 : -1; kind = 'tag'; }
      else { out += '<'; i++; continue; }

      if (end < 0) {
        if (final || n - i > MAX_CARRY) { out += s.slice(i); i = n; } else { this.carry = s.slice(i); i = n; }
        break;
      }
      const tag = s.slice(i, end + 1);
      i = end + 1;
      if (kind === 'pass') { out += tag; continue; }
      out += this.startTag(tag);
    }
    return out;
  }

  endStyle(tail) {
    const css = this.styleBuf + tail;
    this.styleBuf = '';
    return rewriteCss(css, this.base, this.basePath);
  }

  inject(tag, name) {
    if (this.injected || name === 'html') return tag;
    this.injected = true;
    return name === 'head' ? tag + this.runtimeTag : this.runtimeTag + tag;
  }

  startTag(tag) {
    const name = NAME.exec(tag)[1].toLowerCase();
    if (RAW_TEXT.has(name) && !/\/>$/.test(tag)) {
      this.raw = { name, re: new RegExp(`</${name}(?=[\\s/>])`, 'gi'), buffered: name === 'style' };
    }
    if (!INTEREST.test(tag)) return this.inject(tag, name);
    const nameLen = name.length + 1;
    const edits = [];
    let drop = false;
    let attrs = null;

    ATTR.lastIndex = nameLen;
    let m;
    while ((m = ATTR.exec(tag))) {
      const aname = m[1].toLowerCase();
      const value = m[2] ?? m[3] ?? m[4];
      const start = m.index;
      const stop = start + m[0].length;
      if (value === undefined) continue;

      if (aname === 'integrity') { edits.push([start, stop, '']); continue; }
      if (URL_ATTRS.has(aname) && !(aname === 'data' && name !== 'object')) {
        const raw = decodeEntities(value);
        if (name === 'base' && aname === 'href') {
          try { this.base = new URL(raw, this.base); } catch { /* keep previous base */ }
          edits.push([start, stop, `href="${encodeAttr(toProxyPath(this.base, this.basePath))}"`]);
          continue;
        }
        const out = rewriteUrl(raw, this.base, this.basePath);
        if (out !== raw) edits.push([start, stop, `${m[1]}="${encodeAttr(out)}"`]);
      } else if (SRCSET_ATTRS.has(aname)) {
        const raw = decodeEntities(value);
        const out = rewriteSrcset(raw, this.base, this.basePath);
        if (out !== raw) edits.push([start, stop, `${m[1]}="${encodeAttr(out)}"`]);
      } else if (aname === 'style' && /url\(|@import/i.test(value)) {
        const raw = decodeEntities(value);
        const out = rewriteCss(raw, this.base, this.basePath);
        if (out !== raw) edits.push([start, stop, `${m[1]}="${encodeAttr(out)}"`]);
      } else if (aname === 'target' && (name === 'a' || name === 'form' || name === 'area') && /^_(top|parent)$/i.test(value)) {
        edits.push([start, stop, `${m[1]}="_self"`]);
      } else if (name === 'meta') {
        (attrs ??= {})[aname] = { value, start, stop, orig: m[1] };
      }
    }

    if (name === 'meta' && attrs) {
      const equiv = attrs['http-equiv']?.value.toLowerCase();
      if (equiv === 'content-security-policy' || equiv === 'x-frame-options') drop = true;
      else if (equiv === 'refresh' && attrs.content) {
        const c = decodeEntities(attrs.content.value);
        const r = /^(\s*[\d.]*\s*[;,]\s*(?:url\s*=\s*)?)(['"]?)(.+?)\2\s*$/i.exec(c);
        if (r) {
          const out = r[1] + rewriteUrl(r[3], this.base, this.basePath);
          edits.push([attrs.content.start, attrs.content.stop, `${attrs.content.orig}="${encodeAttr(out)}"`]);
        }
      }
    }

    if (drop) return '';
    edits.sort((x, y) => x[0] - y[0]);
    let result = tag;
    for (let k = edits.length - 1; k >= 0; k--) {
      const [a, b, rep] = edits[k];
      result = result.slice(0, a) + rep + result.slice(b);
    }
    if (name === 'base') return result; // never inject before <base>
    return this.inject(result, name);
  }
}

/** Resolve the charset from a Content-Type header value (or null). */
export function charsetFromContentType(ct) {
  const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(ct || '');
  return m ? m[1] : null;
}

function sniffMetaCharset(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const m = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return m ? m[1] : null;
}

export function createHtmlTransform({ base, basePath, runtimeSrc, inject, charset }) {
  const rw = new HtmlRewriter({ base, basePath, runtimeSrc, inject });
  const encoder = new TextEncoder();
  let decoder = null;
  const init = (first) => {
    let label = charset || sniffMetaCharset(first) || 'utf-8';
    try { decoder = new TextDecoder(label); } catch { decoder = new TextDecoder('utf-8'); }
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (!decoder) init(chunk);
      const out = rw.process(decoder.decode(chunk, { stream: true }));
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      if (!decoder) decoder = new TextDecoder('utf-8');
      const out = rw.process(decoder.decode(), true);
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}
