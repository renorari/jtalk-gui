// Checks that engine discovery works against the directory layouts used on
// Windows and Linux, not just the Homebrew one on this machine. Fake installs are
// built in a temp directory and put on PATH.
//
// Discovery deliberately also scans the platform's standard locations, so on a
// machine that really has Open JTalk installed the results include those voices as
// well. These tests therefore assert that the fake install *is* found, not that
// nothing else is.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, findDictionary, findVoices } from '../src/main/engine/paths';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const isWindows = process.platform === 'win32';
const exe = (name: string): string => (isWindows ? `${name}.exe` : name);

function makeTree(root: string, files: string[]): void {
  for (const rel of files) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
    if (/bin[/\\][^/\\]*$/.test(rel) && !isWindows) fs.chmodSync(full, 0o755);
  }
}

function withPath<T>(dirs: string[], fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  try { return fn(); } finally { process.env.PATH = saved; }
}

function main(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jtalk-paths-'));

  // --- Linux/Debian style: binaries in /usr/bin, dictionary under mecab's tree ---
  {
    const root = path.join(tmp, 'linux');
    makeTree(root, [
      path.join('usr', 'bin', exe('open_jtalk')),
      path.join('usr', 'bin', exe('hts_engine')),
      path.join('usr', 'share', 'open_jtalk', 'dic', 'sys.dic'),
      path.join('usr', 'share', 'hts-voice', 'nitech-jp-atr503-m001', 'nitech_jp_atr503_m001.htsvoice'),
      path.join('usr', 'share', 'hts-voice', 'mei', 'mei_normal.htsvoice'),
    ]);
    const bin = path.join(root, 'usr', 'bin');
    const found = withPath([bin], () => which('open_jtalk'));
    check('Linux 配置: バイナリを PATH から発見', found === path.join(bin, exe('open_jtalk')), String(found));

    const dic = findDictionary(found);
    check('Linux 配置: 辞書を発見',
      dic === path.join(root, 'usr', 'share', 'open_jtalk', 'dic'), String(dic));

    const voices = findVoices(found).map((v) => v.path);
    check('Linux 配置: htsvoice を発見',
      voices.includes(path.join(root, 'usr', 'share', 'hts-voice', 'mei', 'mei_normal.htsvoice'))
      && voices.includes(path.join(root, 'usr', 'share', 'hts-voice', 'nitech-jp-atr503-m001', 'nitech_jp_atr503_m001.htsvoice')),
      `${voices.length} 件中にフェイク環境の 2 件を含む`);
  }

  // --- Windows style: everything under an install directory ---
  {
    const root = path.join(tmp, 'win', 'open_jtalk');
    makeTree(root, [
      path.join('bin', exe('open_jtalk')),
      path.join('bin', exe('hts_engine')),
      path.join('dic', 'sys.dic'),
      path.join('voice', 'mei', 'mei_happy.htsvoice'),
    ]);
    const bin = path.join(root, 'bin');
    const found = withPath([bin], () => which('open_jtalk'));
    check('Windows 配置: バイナリを PATH から発見', found === path.join(bin, exe('open_jtalk')), String(found));
    check('Windows 配置: 辞書を発見', findDictionary(found) === path.join(root, 'dic'),
      String(findDictionary(found)));
    check('Windows 配置: htsvoice を発見',
      findVoices(found).some((v) => v.path === path.join(root, 'voice', 'mei', 'mei_happy.htsvoice')));
  }

  // --- versioned dictionary directory, as the upstream tarball ships it ---
  {
    const root = path.join(tmp, 'tarball');
    makeTree(root, [
      path.join('bin', exe('open_jtalk')),
      path.join('open_jtalk_dic_utf_8-1.11', 'sys.dic'),
    ]);
    const found = withPath([path.join(root, 'bin')], () => which('open_jtalk'));
    check('配布 tarball 配置: バージョン付き辞書を発見',
      findDictionary(found) === path.join(root, 'open_jtalk_dic_utf_8-1.11'),
      String(findDictionary(found)));
  }

  // --- missing engine must be reported, not guessed ---
  {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const found = withPath([empty], () => which('definitely_not_open_jtalk'));
    check('未インストール時は null を返す', found === null, String(found));
    // A system install may still be found; what matters is that nothing is
    // invented inside the empty tree.
    const dic = findDictionary(path.join(empty, 'bin', 'x'));
    check('空のツリーから辞書をでっち上げない', dic === null || !dic.startsWith(empty), String(dic));
  }

  // --- extra voice directories from settings are searched ---
  {
    const extra = path.join(tmp, 'myvoices');
    makeTree(extra, [path.join('custom', 'my_voice.htsvoice')]);
    const voices = findVoices(null, [extra]);
    check('設定で追加したディレクトリの音声を発見',
      voices.some((v) => v.name === 'my_voice'), voices.map((v) => v.name).join(', '));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\n  すべて成功\n' : `\n  ${failures} 件失敗\n`);
  process.exit(failures ? 1 : 0);
}

main();
