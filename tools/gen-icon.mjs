// Renders build/icon.svg into the icon formats electron-builder needs.
//
// build/icon.svg is the finished artwork: a full-bleed 1024x1024 square. macOS
// does not round or inset an .icns for you, so the square is fitted into Apple's
// icon template here (824pt body inset by 100pt, corner radius 185.4pt) and
// clipped. Windows and Linux get the same rounded composition.
//
// build/jtalk-gui.icon/ is the Icon Composer bundle for macOS 26's native icon
// format. Nothing consumes it yet; it is kept as the editable original.
//
// The generated files are committed so a normal build needs none of these tools.
// Re-run after editing the artwork:  npm run gen-icon
// Requires rsvg-convert (librsvg). The .icns additionally needs macOS's
// iconutil, and the Windows .ico needs ImageMagick.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'build', 'icon.svg');
const out = path.join(root, 'build');

const have = (cmd) => {
  try { execFileSync('which', [cmd], { stdio: 'pipe' }); return true; } catch { return false; }
};

if (!have('rsvg-convert')) {
  console.error('rsvg-convert が必要です: brew install librsvg');
  process.exit(1);
}

const BODY = 824, INSET = 100, RADIUS = 185.4;
const scale = BODY / 1024;

const artwork = fs.readFileSync(source).toString('base64');

const composed = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="squircle">
      <rect x="${INSET}" y="${INSET}" width="${BODY}" height="${BODY}" rx="${RADIUS}" ry="${RADIUS}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <image x="${INSET}" y="${INSET}" width="${BODY}" height="${BODY}"
           xlink:href="data:image/svg+xml;base64,${artwork}"/>
  </g>
</svg>
`;
void scale;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jtalk-icon-'));
const composedFile = path.join(tmpRoot, 'composed.svg');
fs.writeFileSync(composedFile, composed);

const png = (size, dest) =>
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), composedFile, '-o', dest]);

png(1024, path.join(out, 'icon.png'));
console.log('build/icon.png');

if (process.platform === 'darwin' && have('iconutil')) {
  const set = path.join(tmpRoot, 'icon.iconset');
  fs.mkdirSync(set, { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512]) {
    png(size, path.join(set, `icon_${size}x${size}.png`));
    png(size * 2, path.join(set, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(out, 'icon.icns')]);
  console.log('build/icon.icns');
} else {
  console.log('(.icns は macOS でのみ生成します)');
}

if (have('magick')) {
  const files = [16, 24, 32, 48, 64, 128, 256].map((s) => {
    const f = path.join(tmpRoot, `${s}.png`);
    png(s, f);
    return f;
  });
  execFileSync('magick', [...files, path.join(out, 'icon.ico')]);
  console.log('build/icon.ico');
} else {
  console.log('(.ico は ImageMagick が必要です)');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
