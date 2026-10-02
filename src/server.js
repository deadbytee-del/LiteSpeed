import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeServer } from './adapters/node.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Serve the built frontend (dist/) if present, otherwise the source frontend (web/).
const fs = await import('node:fs');
const staticDir = process.env.LITESPEED_STATIC_DIR || (fs.existsSync(path.join(root, 'dist')) ? path.join(root, 'dist') : path.join(root, 'web'));

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '127.0.0.1';
const { server } = createNodeServer({ staticDir });
server.listen(port, host, () => {
  console.log(`LiteSpeed listening on http://${host}:${port}`);
  console.log(`  frontend: ${staticDir}`);
  console.log(`  health:   http://${host}:${port}/api/health`);
});
