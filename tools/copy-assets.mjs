// Copies renderer assets (html/css) that tsc does not handle into dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');

fs.mkdirSync(out, { recursive: true });
let n = 0;
for (const entry of fs.readdirSync(src)) {
  if (/\.(html|css|svg|png)$/.test(entry)) {
    fs.copyFileSync(path.join(src, entry), path.join(out, entry));
    n++;
  }
}

// Vendor Sashimi UI in: the renderer runs under a CSP of 'self', so stylesheets
// have to be served from dist rather than node_modules.
const vendorOut = path.join(out, 'vendor');
fs.mkdirSync(vendorOut, { recursive: true });
const sashimi = path.join(root, 'node_modules', 'sashimi-ui', 'dist', 'css');
for (const [from, to] of [['default.theme.css', 'sashimi-theme.css'], ['sui-bundle.css', 'sashimi.css']]) {
  fs.copyFileSync(path.join(sashimi, from), path.join(vendorOut, to));
  n++;
}

console.log(`copied ${n} asset(s) to dist/renderer`);
