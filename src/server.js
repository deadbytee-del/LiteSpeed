import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeServer, defaultWorkerCount } from './adapters/node.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Serve the built frontend (dist/) if present, otherwise the source frontend (web/).
const staticDir = process.env.LITESPEED_STATIC_DIR || (fs.existsSync(path.join(root, 'dist')) ? path.join(root, 'dist') : path.join(root, 'web'));
const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';

const w = process.env.LITESPEED_WORKERS;
const workers = !w || w === 'auto' ? defaultWorkerCount() : Math.max(1, Number(w) || 1);

if (workers > 1 && cluster.isPrimary) {
  console.log(`LiteSpeed on http://${host}:${port}  (${workers} workers)`);
  console.log(`  frontend: ${staticDir}`);
  console.log(`  bare relay: http://${host}:${port}/bare/v3/   health: http://${host}:${port}/api/health`);
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    if (!shuttingDown) { console.error(`worker ${worker.process.pid} exited (${code}); restarting`); cluster.fork(); }
  });
  let shuttingDown = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shuttingDown = true; for (const id in cluster.workers) cluster.workers[id].kill(); process.exit(0); });
} else {
  const { server, close } = createNodeServer({ staticDir });
  const scheme = process.env.LITESPEED_TLS_CERT ? 'https' : 'http';
  server.listen({ port, host, backlog: 2048 }, () => {
    if (workers <= 1) {
      console.log(`LiteSpeed on ${scheme}://${host}:${port}${scheme === 'https' ? ' (HTTP/2)' : ''}`);
      console.log(`  frontend: ${staticDir}`);
      console.log(`  bare relay: http://${host}:${port}/bare/v3/   health: http://${host}:${port}/api/health`);
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { close(); process.exit(0); });
}
