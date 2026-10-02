import { tokenizer, tokTypes as tt } from 'acorn';
import { rewriteUrl } from '../url/codec.js';

/**
 * Token-level JavaScript rewriter. It never builds an AST and only touches the
 * handful of places where a page can observe or escape the proxy:
 *
 *   location / X.location      -> fake location (real upstream URL)
 *   top / parent (+ .member)   -> the proxied window, so frame-busters stay inside
 *   x.postMessage(...)         -> origin-agnostic postMessage (all proxied pages share one real origin)
 *   import "…" / import("…")   -> proxied module specifiers
 *
 * Every replacement is syntactically safe by construction (see the position
 * rules below), and any tokenizer error returns the original source untouched.
 * The helpers __ls$g, __ls$loc, __ls$top, __ls$parent are defined by the runtime.
 */
const QUICK = /location|\btop\b|\bparent\b|\bimport\b|\bexport\b|postMessage/;

const OPERATORS_BEFORE_VALUE = new Set([
  tt.eq, tt.equality, tt.logicalOR, tt.logicalAND, tt.coalesce, tt.question, tt.colon, tt._return, tt._typeof,
  tt.prefix, tt.plusMin, tt.arrow, tt._in, tt._instanceof, tt._void, tt._throw,
]);
const STATEMENT_START = new Set([tt.semi, tt.braceR, tt.braceL, tt.parenR, tt._else, tt._do]);
const DECLARATORS = new Set([tt._var, tt._const, tt._function, tt._class]);

function* tokensOf(code, sourceType) {
  yield* tokenizer(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true });
}

export function rewriteJs(code, base, basePath) {
  if (!QUICK.test(code)) return code;
  let edits;
  try { edits = scan(code, 'script', base, basePath); } catch {
    try { edits = scan(code, 'module', base, basePath); } catch { return code; }
  }
  if (!edits.length) return code;
  let out = '';
  let last = 0;
  for (const [start, end, text] of edits) { out += code.slice(last, start) + text; last = end; }
  return out + code.slice(last);
}

/** One pass with a three-token window (prev2, prev, current) + one token of lookahead; no token array. */
function scan(code, sourceType, base, basePath) {
  const edits = [];
  const edit = (t, text) => edits.push([t.start, t.end, text]);
  let p2 = null; let p = null; let cur = null;

  const visit = (next) => {
    const t = cur;
    const prev = p;
    if (t.type === tt.name) {
      const v = t.value;
      const afterDot = prev && (prev.type === tt.dot || prev.type === tt.questionDot);

      if (afterDot) {
        if (v === 'postMessage' && next && next.type === tt.parenL) edit(t, '__ls$pm');
        else if (v === 'location') edit(t, '__ls$loc');
        else if ((v === 'top' || v === 'parent') && prev.type === tt.dot) {
          const owner = p2;
          if (owner && owner.type === tt.name && (owner.value === 'window' || owner.value === 'self' || owner.value === 'globalThis' || owner.value === 'frames')) edit(t, `__ls$${v}`);
        }
        return;
      }
      if (v !== 'location' && v !== 'top' && v !== 'parent') return;
      if (prev && (DECLARATORS.has(prev.type) || (prev.type === tt.name && (prev.value === 'let' || prev.value === 'get' || prev.value === 'set' || prev.value === 'static' || prev.value === 'async')))) return;

      const memberNext = next && (next.type === tt.dot || next.type === tt.questionDot || next.type === tt.bracketL);
      // `top === self`, `parent != window`: frame-busting checks compare the bare identifiers.
      const compared = (v === 'top' || v === 'parent') && ((next && next.type === tt.equality) || (prev && prev.type === tt.equality));
      if (memberNext || compared) edit(t, `__ls$g(${v})`);
      else if (v === 'location' && prev) {
        if (OPERATORS_BEFORE_VALUE.has(prev.type) && !(prev.type === tt.colon && next && next.type === tt.colon)) edit(t, '__ls$g(location)');
        else if (STATEMENT_START.has(prev.type) && next && next.type === tt.eq) edit(t, '__ls$loc');
      } else if (v === 'location' && !prev && next && next.type === tt.eq) edit(t, '__ls$loc');
      return;
    }

    if (t.type === tt.string && prev) {
      const isSpecifier =
        prev.type === tt._import || prev.type === tt._export ||
        (prev.type === tt.name && prev.value === 'from') ||
        (prev.type === tt.parenL && p2 && p2.type === tt._import);
      if (isSpecifier && /^(?:https?:)?\/|^\/[^/]/.test(t.value) && t.value[0] !== '.') {
        const q = code[t.start];
        const rewritten = rewriteUrl(t.value, base, basePath);
        if (rewritten !== t.value) edit(t, q + rewritten + q);
      }
    }
  };

  for (const next of tokensOf(code, sourceType)) {
    if (cur) { visit(next); p2 = p; p = cur; }
    cur = next;
  }
  if (cur) visit(null);
  return edits;
}

const JS_TYPES = /^(?:$|module$|(?:text|application)\/(?:x-)?(?:javascript|ecmascript)$|jscript$|livescript$)/i;
export const isJsScriptType = (type) => JS_TYPES.test((type || '').trim());
