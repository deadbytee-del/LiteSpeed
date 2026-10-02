// Bundles the service worker (engine + rewriters + adblock + runtime) into web/sw.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function bundleSw() {
  const res = await build({
    entryPoints: [path.join(root, 'src/sw/sw.js')],
    bundle: true, minify: true, format: 'iife', target: 'es2021', legalComments: 'none', write: false,
    outfile: path.join(root, 'web/sw.js'), logLevel: 'warning',
  });
  return res.outputFiles[0].contents;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const out = path.join(root, 'web/sw.js');
  fs.writeFileSync(out, await bundleSw());
  console.log(`web/sw.js  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
