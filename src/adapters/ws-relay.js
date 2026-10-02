import { WebSocketServer, WebSocket } from 'ws';
import { checkTarget } from '../security/guard.js';
import { ProxyError } from '../errors.js';
import { createGuardedLookup } from './node-transport.js';

/**
 * WebSocket relay for the Node adapter: GET /api/ws?url=wss://host/path[&origin=…]
 * with an Upgrade. Messages (text and binary) and close codes are piped both ways.
 * Subprotocol negotiation is done against the upstream first, so the client gets
 * the protocol the remote actually selected.
 */
export function attachWebSocketRelay(server, { config, allowedOrigin, basePath = '' }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const lookup = createGuardedLookup({ allowPrivate: config.allowPrivate });

  const reject = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== `${basePath}/api/ws`) return reject(socket, 404, 'Not Found');
    if (!allowedOrigin(req.headers.origin)) return reject(socket, 403, 'Forbidden');

    let target;
    try {
      target = new URL(u.searchParams.get('url') || '');
      if (target.protocol === 'ws:') target.protocol = 'http:'; else if (target.protocol === 'wss:') target.protocol = 'https:';
      checkTarget(target, config, req.headers.host);
      target.protocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
    } catch (e) {
      return reject(socket, e instanceof ProxyError ? e.status : 400, 'Bad Request');
    }

    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = u.searchParams.get('origin') || target.origin.replace(/^ws/, 'http');
    const upstream = new WebSocket(target.href, protocols, {
      lookup,
      origin,
      headers: { 'user-agent': req.headers['user-agent'] || 'LiteSpeed' },
      handshakeTimeout: config.timeoutMs,
    });

    // Upstream may speak first; hold its messages until the client side is attached.
    let client = null;
    const queued = [];
    upstream.on('message', (data, isBinary) => {
      if (client) { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }); } else queued.push([data, isBinary]);
    });
    upstream.once('error', () => reject(socket, 502, 'Bad Gateway'));
    upstream.once('open', () => {
      wss.handleUpgrade(req, socket, head, (c) => {
        client = c;
        upstream.removeAllListeners('error');
        for (const [data, isBinary] of queued.splice(0)) client.send(data, { binary: isBinary });
        client.on('message', (data, isBinary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary }); });
        const closeBoth = (code) => (c) => {
          const ok = (n) => n >= 1000 && n <= 4999 && n !== 1005 && n !== 1006 && n !== 1015;
          const use = ok(c) ? c : 1000;
          const other = code === 'client' ? upstream : client;
          if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING) other.close(use);
        };
        client.on('close', closeBoth('client'));
        upstream.on('close', closeBoth('upstream'));
        client.on('error', () => upstream.terminate());
        upstream.on('error', () => client.terminate());
      });
    });
    // Pick the protocol the remote chose.
    wss.options.handleProtocols = () => upstream.protocol || false;
  });
  return wss;
}
