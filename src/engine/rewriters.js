import { createHtmlTransform, charsetFromContentType } from '../rewrite/html.js';
import { rewriteCss, bufferedTextTransform } from '../rewrite/css.js';
import { rewriteModuleSpecifiers } from '../rewrite/js.js';

/**
 * A rewriter claims a content type and returns a stream transform.
 *   { name, test(contentType) -> bool, create(ctx) -> TransformStream, contentType?(orig) }
 * Add entries here (or pass your own list to ProxyEngine) to support new types.
 */
export function createRewriters(config) {
  const list = [
    {
      name: 'html',
      test: (ct) => /^(text\/html|application\/xhtml\+xml)\b/i.test(ct),
      create: (ctx) => createHtmlTransform({ ...ctx, charset: charsetFromContentType(ctx.contentType) }),
      contentType: (orig) => (/xhtml/i.test(orig) ? 'application/xhtml+xml; charset=utf-8' : 'text/html; charset=utf-8'),
    },
    {
      name: 'css',
      test: (ct) => /^text\/css\b/i.test(ct),
      create: (ctx) => bufferedTextTransform((t) => rewriteCss(t, ctx.base, ctx.basePath), { charset: charsetFromContentType(ctx.contentType) || 'utf-8' }),
      contentType: () => 'text/css; charset=utf-8',
    },
  ];
  if (config.rewriteJs) {
    list.push({
      name: 'js',
      test: (ct) => /^(text|application)\/(x-)?(javascript|ecmascript)\b/i.test(ct),
      create: (ctx) => bufferedTextTransform((t) => rewriteModuleSpecifiers(t, ctx.base, ctx.basePath), { charset: charsetFromContentType(ctx.contentType) || 'utf-8' }),
      contentType: () => 'text/javascript; charset=utf-8',
    });
  }
  return list;
}
