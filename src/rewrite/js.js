import { rewriteUrl } from '../url/codec.js';

// Static/dynamic ES module specifiers that are absolute URLs. Everything else in
// the script is left untouched: full JS rewriting is deliberately not attempted.
const SPEC = /(\b(?:import|export)\b(?:[^'"`;()]*?\bfrom\b)?\s*\(?\s*)(["'])((?:https?:)?\/\/[^"'\s]+)\2/g;

export function rewriteModuleSpecifiers(code, base, basePath) {
  if (!code.includes('//')) return code;
  return code.replace(SPEC, (m, pre, q, spec) => `${pre}${q}${rewriteUrl(spec, base, basePath)}${q}`);
}
