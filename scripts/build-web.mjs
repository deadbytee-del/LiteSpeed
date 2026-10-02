// Copies web/ to dist/ and writes dist/config.json from LITESPEED_API_URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'web'), out, { recursive: true });

const apiUrl = (process.env.LITESPEED_API_URL || '').trim().replace(/\/+$/, '');
if (apiUrl && !/^https?:\/\//.test(apiUrl)) {
  console.error(`LITESPEED_API_URL must start with http:// or https:// (got "${apiUrl}")`);
  process.exit(1);
}
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({ apiUrl }, null, 2) + '\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`dist/ ready. apiUrl=${apiUrl || '(auto-detect)'}`);
