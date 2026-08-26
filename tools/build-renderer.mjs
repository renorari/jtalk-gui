// Bundles the renderer into a single classic script.
//
// The renderer shares the pure engine code (label/edit/tables) with the main
// process, so it needs a bundler; none of that code touches Node built-ins, so it
// runs unchanged in the browser context.
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'src', 'renderer', 'renderer.ts')],
  outfile: path.join(root, 'dist', 'renderer', 'renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching renderer…');
} else {
  await esbuild.build(options);
}
