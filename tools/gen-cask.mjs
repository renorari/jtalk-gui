// Writes homebrew/Casks/jtalk-gui.rb from the artifacts in release/.
//
// Run this after `npm run dist:mac`, then copy the file into your tap repository
// (or publish this directory as the tap). Usage: node tools/gen-cask.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Read the bundle id from the builder config rather than repeating it, so the
// zap stanza cannot drift away from what the app actually registers.
const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const appId = /^appId:\s*(\S+)/m.exec(builderConfig)?.[1];
if (!appId) {
  console.error('electron-builder.yml から appId を読めませんでした');
  process.exit(1);
}

const version = pkg.version;
const repo = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
if (!repo) {
  console.error('package.json に repository.url がありません');
  process.exit(1);
}

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Refuse to describe a build Gatekeeper would reject.
 *
 * Unsigned builds get made all the time while testing the packaging, and a cask
 * generated from one looks completely normal: it only fails later, for users,
 * as a checksum mismatch or a blocked app.
 */
function assertNotarized(appDir) {
  if (!fs.existsSync(appDir)) {
    console.error(`見つかりません: ${path.relative(root, appDir)}`);
    process.exit(1);
  }
  const info = spawnSync('codesign', ['-dv', '--verbose=4', appDir], { encoding: 'utf8' });
  const out = `${info.stdout ?? ''}${info.stderr ?? ''}`;
  const authority = /Authority=(.+)/.exec(out)?.[1] ?? '(不明)';

  const stapled = spawnSync('xcrun', ['stapler', 'validate', appDir], { encoding: 'utf8' });

  if (!authority.startsWith('Developer ID Application') || stapled.status !== 0) {
    console.error(`${path.relative(root, appDir)} は配布できる状態ではありません。`);
    console.error(`  署名者: ${authority}`);
    console.error(`  公証チケット: ${stapled.status === 0 ? '添付済み' : '未添付'}`);
    console.error('');
    console.error('未署名や未公証のビルドから cask を作ると、利用者側では');
    console.error('チェックサム不一致や Gatekeeper のブロックとして現れます。');
    console.error('npm run dist:mac:release で作り直してください。');
    process.exit(1);
  }
}

const arches = { arm64: 'arm', x64: 'intel' };
// electron-builder names the native-arch output directory without a suffix.
const appDirs = { arm64: 'mac-arm64', x64: 'mac' };
const sums = {};
for (const [arch, caskArch] of Object.entries(arches)) {
  assertNotarized(path.join(root, 'release', appDirs[arch], `${pkg.productName}.app`));
  const file = path.join(root, 'release', `${pkg.name}-${version}-${arch}.dmg`);
  const sum = sha256(file);
  if (!sum) {
    console.error(`見つかりません: ${path.relative(root, file)}`);
    console.error('先に `npm run dist:mac` を実行してください（cask は dmg を配布します）。');
    process.exit(1);
  }
  sums[caskArch] = sum;
  console.log(`${arch}: ${sum}`);
}

const cask = `cask "${pkg.name}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sums.arm}",
         intel: "${sums.intel}"

  url "${repo}/releases/download/v#{version}/${pkg.name}-#{version}-#{arch}.dmg",
      verified: "${repo.replace(/^https?:\/\//, '')}/"
  name "${pkg.productName}"
  desc "${pkg.description}"
  homepage "${repo}"

  depends_on formula: "open-jtalk"
  # A bare symbol already means "or newer" to Homebrew; ">= :big_sur" is a
  # style offence (Homebrew/OSDependsOn).
  depends_on macos: :big_sur

  app "${pkg.productName}.app"

  zap trash: [
    "~/Library/Application Support/${pkg.productName}",
    "~/Library/Preferences/${appId}.plist",
    "~/Library/Saved Application State/${appId}.savedState",
  ]
end
`;

const out = path.join(root, 'homebrew', 'Casks', `${pkg.name}.rb`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, cask);
console.log(`\n${path.relative(root, out)} を書き出しました`);
