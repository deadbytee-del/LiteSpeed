import http from 'node:http';
import http2 from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createApp } from '../index.js';
import { loadConfig } from '../config.js';
import { Limiter } from '../limits.js';
import { NodeTransport } from './node-transport.js';
import { attachWebSocketRelay } from './ws-relay.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|xhtml\+xml|manifest\+json|wasm)|image\/svg\+xml|font\/(ttf|otf)|application\/x-font)/i;

function toRequest(req, res, trustProxy) {
  const proto = trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : 'http';
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host || req.headers[':authority'] || 'localhost';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.charCodeAt(0) === 58) continue; // HTTP/2 pseudo-headers
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else if (v != null) headers.set(k, v);
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const init = { method: req.method, headers, signal: ac.signal };
  if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = Readable.toWeb(req); init.duplex = 'half'; }
  return new Request(`${proto}://${host}${req.url}`, init);
}

function pickEncoding(req, headers, status, pressure = 0) {
  if (pressure > 0.75) return null; // shed CPU first when close to the in-flight cap
  if (status === 206 || status === 204 || status === 304 || headers.has('content-encoding')) return null;
  if (!COMPRESSIBLE.test(headers.get('content-type') || '')) return null;
  if (/no-transform/i.test(headers.get('cache-control') || '')) return null;
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

async function send(req, res, response, pressure) {
  const headers = response.headers;
  const out = {};
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const [k, v] of headers) if (k !== 'set-cookie') out[k] = v;
  if (cookies.length) out['set-cookie'] = cookies;

  if (!response.body || req.method === 'HEAD') {
    res.writeHead(response.status, out);
    return res.end();
  }
  const enc = pickEncoding(req, headers, response.status, pressure);
  if (enc) {
    delete out['content-length'];
    out['content-encoding'] = enc;
    out.vary = out.vary ? out.vary + ', accept-encoding' : 'accept-encoding';
  }
  res.writeHead(response.status, out);
  const src = Readable.fromWeb(response.body);
  const z = enc === 'br'
    ? zlib.createBrotliCompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
    : enc === 'gzip' ? zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH, level: 6 }) : null;
  try {
    await (z ? pipeline(src, z, res) : pipeline(src, res));
  } catch { /* client went away or upstream aborted mid-stream */ }
}

function serveStatic(root, pathname, req, res) {
  try { pathname = decodeURIComponent(pathname); } catch { return false; }
  let file = path.join(root, pathname);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.statSync(file).isFile()) return false;
  } catch { return false; }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': 'public, max-age=300' };
  const enc = COMPRESSIBLE.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  if (enc) headers['content-encoding'] = 'gzip';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  const stream = fs.createReadStream(file);
  (enc ? pipeline(stream, zlib.createGzip(), res) : pipeline(stream, res)).catch(() => {});
  return true;
}

const clientIp = (req, trustProxy) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

export function createNodeServer({ env = process.env, staticDir, app } = {}) {
  const trustProxy = /^(1|on|true)$/i.test(env.LITESPEED_TRUST_PROXY || '');
  const config = loadConfig(env);
  const transport = new NodeTransport({ allowPrivate: config.allowPrivate, upstreamProxy: env.LITESPEED_UPSTREAM_PROXY || '' });
  const lit = app || createApp({ env, runtime: `node ${process.version}`, transport });
  const root = staticDir && fs.existsSync(staticDir) ? path.resolve(staticDir) : null;
  const limiter = new Limiter({ maxInflight: lit.config.maxInflight, ratePerSec: lit.config.rateLimit });

  // With a certificate the server speaks HTTP/2 (and still accepts HTTP/1.1 and WebSocket upgrades).
  // One multiplexed connection removes the browser's 6-connections-per-origin limit, which otherwise
  // throttles a service-worker page whose every sub-resource goes through the relay.
  const tlsKey = env.LITESPEED_TLS_KEY && fs.readFileSync(env.LITESPEED_TLS_KEY);
  const tlsCert = env.LITESPEED_TLS_CERT && fs.readFileSync(env.LITESPEED_TLS_CERT);
  const create = tlsKey && tlsCert ? (h) => http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, settings: { maxConcurrentStreams: 256 } }, h) : (h) => http.createServer(h);

  const server = create(async (req, res) => {
    let slot;
    try {
      const pathname = (req.url || '/').split('?')[0];
      const isApp = pathname.startsWith('/p/') || pathname.startsWith('/bare') || (pathname.startsWith('/api/') && pathname !== '/api/');
      const wantsHtml = String(req.headers.accept || '').includes('text/html');
      if (root && !isApp && (req.method === 'GET' || req.method === 'HEAD')) {
        // The docs page doubles as the JSON index when the client asks for HTML.
        const docs = (pathname === '/api' || pathname === '/api/') && wantsHtml;
        if (serveStatic(root, docs ? '/api/index.html' : pathname, req, res)) return;
      }
      const metered = pathname.startsWith('/p/') || pathname.startsWith('/bare/v3');
      if (metered) {
        slot = limiter.acquire(clientIp(req, trustProxy));
        if (slot.rejected) {
          res.writeHead(slot.rejected === 'overloaded' ? 503 : 429, { 'content-type': 'application/json', 'retry-after': String(slot.retryAfter), 'access-control-allow-origin': '*' });
          return res.end(JSON.stringify({ error: { status: slot.rejected === 'overloaded' ? 503 : 429, code: slot.rejected, message: slot.rejected === 'overloaded' ? 'The server is at capacity. Retry shortly.' : 'Too many requests.' } }));
        }
        res.on('close', slot.release);
      }
      const response = await lit.fetch(toRequest(req, res, trustProxy), env, {});
      await send(req, res, response, limiter.pressure);
    } catch (err) {
      slot?.release?.();
      console.error('[litespeed] unhandled', err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"status":500,"code":"internal_error","message":"Internal error"}}');
    }
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0; // long downloads/streams are bounded by socket idleness, not total time

  const origins = lit.config.allowedOrigins;
  attachWebSocketRelay(server, {
    config: lit.config,
    allowedOrigin: (o) => origins.includes('*') || !o || origins.includes(o.toLowerCase().replace(/\/$/, '')),
    basePath: lit.config.basePath,
  });

  return { server, app: lit, limiter, transport, close: () => { server.close(); transport.close(); } };
}

export const defaultWorkerCount = () => Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 4));
