import { createHtmlTransform, charsetFromContentType } from '../rewrite/html.js';
import { rewriteCss, bufferedTextTransform } from '../rewrite/css.js';
import { rewriteJs } from '../rewrite/js.js';
import { stripJsonKeys, isYoutubeHost, isYoutubeApiPath } from '../adblock/json-prune.js';

const isWorker = (dest) => /worker|worklet/.test(dest || '');

/**
 * A rewriter claims a content type and returns a stream transform:
 *   { name, test(contentType, { dest }) -> bool, create(ctx) -> TransformStream, contentType?(orig) }
 * Add entries here (or pass your own list to ProxyEngine) to support new types.
 */
export function createRewriters(config) {
  const cs = (ctx) => charsetFromContentType(ctx.contentType) || 'utf-8';
  const list = [
    {
      name: 'html',
      test: (ct) => /^(text\/html|application\/xhtml\+xml)\b/i.test(ct),
      create: (ctx) => createHtmlTransform({
        base: ctx.base, basePath: ctx.basePath, inject: ctx.inject, runtimeTag: ctx.runtimeTag, headExtra: ctx.headExtra,
        rewriteScripts: config.rewriteJs, scriptFilter: ctx.scriptFilter, charset: charsetFromContentType(ctx.contentType),
      }),
      contentType: (orig) => (/xhtml/i.test(orig) ? 'application/xhtml+xml; charset=utf-8' : 'text/html; charset=utf-8'),
    },
    {
      name: 'css',
      test: (ct) => /^text\/css\b/i.test(ct),
      create: (ctx) => bufferedTextTransform((t) => rewriteCss(t, ctx.base, ctx.basePath), { charset: cs(ctx) }),
      contentType: () => 'text/css; charset=utf-8',
    },
  ];
  if (config.adblock) {
    list.push({
      name: 'adjson',
      test: (ct, { url }) => /json/i.test(ct) && url && isYoutubeHost(url.hostname) && isYoutubeApiPath(url.pathname),
      create: (ctx) => bufferedTextTransform((t) => stripJsonKeys(t), { charset: cs(ctx) }),
      contentType: (orig) => orig,
    });
  }
  if (config.rewriteJs) {
    list.push({
      name: 'js',
      // Workers have no runtime (the helpers it defines would be missing), so they get the original source.
      test: (ct, { dest }) => /^(text|application)\/(x-)?(javascript|ecmascript)\b/i.test(ct) && !isWorker(dest),
      create: (ctx) => bufferedTextTransform((t) => rewriteJs(t, ctx.base, ctx.basePath), { charset: cs(ctx) }),
      contentType: () => 'text/javascript; charset=utf-8',
    });
  }
  return list;
}

export { isWorker };
