// Checks a built .app the way Gatekeeper will on someone else's Mac.
//
// Run after `npm run dist:mac:release`:
//   node tools/verify-release.mjs "release/mac-arm64/JTalk GUI.app"
// Without an argument it checks every .app under release/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function findApps() {
  const release = path.join(root, 'release');
  if (!fs.existsSync(release)) return [];
  const apps = [];
  for (const entry of fs.readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(release, entry.name);
    for (const inner of fs.readdirSync(dir)) {
      if (inner.endsWith('.app')) apps.push(path.join(dir, inner));
    }
  }
  return apps;
}

const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : findApps();
if (targets.length === 0) {
  console.error('.app が見つかりません。先に npm run dist:mac を実行してください。');
  process.exit(1);
}

let failed = 0;

for (const app of targets) {
  console.log(`\n${path.relative(root, app)}`);

  // 1. Is the signature intact and does it cover everything?
  const sign = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  console.log(`  ${sign.ok ? 'ok  ' : 'FAIL'}  署名の整合性`);
  if (!sign.ok) { failed++; console.log(indent(sign.out)); }

  // 2. Which authority signed it? Development certificates are rejected elsewhere.
  const info = run('codesign', ['-dv', '--verbose=4', app]);
  const authority = /Authority=(.+)/.exec(info.out)?.[1] ?? '(不明)';
  const runtime = /flags=.*runtime/.test(info.out);
  const isDeveloperId = authority.startsWith('Developer ID Application');
  console.log(`  ${isDeveloperId ? 'ok  ' : 'FAIL'}  署名者: ${authority}`);
  if (!isDeveloperId) {
    failed++;
    console.log(indent('配布には "Developer ID Application" 証明書が必要です。'));
  }
  console.log(`  ${runtime ? 'ok  ' : 'FAIL'}  Hardened Runtime`);
  if (!runtime) failed++;

  // 3. Is the notarization ticket stapled? Without it, an offline first launch fails.
  const staple = run('xcrun', ['stapler', 'validate', app]);
  console.log(`  ${staple.ok ? 'ok  ' : 'FAIL'}  公証チケットの添付 (stapler)`);
  if (!staple.ok) { failed++; console.log(indent(staple.out.trim())); }

  // 4. What Gatekeeper itself concludes.
  const spctl = run('spctl', ['-a', '-vvv', '-t', 'exec', app]);
  const accepted = /: accepted/.test(spctl.out);
  const notarized = /source=Notarized Developer ID/.test(spctl.out);
  console.log(`  ${accepted && notarized ? 'ok  ' : 'FAIL'}  Gatekeeper 判定: ${(/source=(.*)/.exec(spctl.out)?.[1] ?? spctl.out.trim())}`);
  if (!(accepted && notarized)) failed++;
}

function indent(text) {
  return text.trim().split('\n').map((l) => `        ${l}`).join('\n');
}

console.log(failed === 0
  ? '\n配布可能な状態です。\n'
  : `\n${failed} 件の問題があります。公証していないビルドはユーザー側で Gatekeeper に止められます。\n`);
process.exit(failed ? 1 : 0);
