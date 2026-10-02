// Copies web/ to dist/ and writes dist/config.json from LITESPEED_API_URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'web'), out, { recursive: true });

// One URL, or several comma-separated relays (the service worker fails over between them).
const apiUrls = (process.env.LITESPEED_API_URL || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
for (const u of apiUrls) {
  if (!/^https?:\/\//.test(u)) { console.error(`LITESPEED_API_URL entries must start with http:// or https:// (got "${u}")`); process.exit(1); }
}
const apiUrl = apiUrls.join(',');
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ apiUrl }, null, 2) + '\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`dist/ ready. apiUrl=${apiUrl || '(auto-detect)'}`);
