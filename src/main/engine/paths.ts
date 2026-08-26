// Locates the open_jtalk binary, its dictionary, hts_engine and the .htsvoice files
// on macOS, Windows and Linux. Everything is overridable from the settings pane;
// these are only the places we probe when nothing is configured.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EnginePaths, VoiceInfo } from '../../shared/types';

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Executable extensions to try on Windows, in PATHEXT order. */
function executableNames(name: string): string[] {
  if (!isWindows) return [name];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [...exts.map((e) => name + e.toLowerCase()), name];
}

/** Directories to check in addition to PATH, per platform. */
function binCandidates(): string[] {
  if (isWindows) {
    const programFiles = [
      process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA,
    ].filter((v): v is string => !!v);
    return [
      ...programFiles.flatMap((root) => [
        path.join(root, 'open_jtalk', 'bin'),
        path.join(root, 'OpenJTalk', 'bin'),
        path.join(root, 'open_jtalk'),
      ]),
      'C:\\open_jtalk\\bin',
      path.join(os.homedir(), 'scoop', 'shims'),
    ];
  }
  if (isMac) {
    return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
  }
  return ['/usr/bin', '/usr/local/bin', '/opt/open_jtalk/bin', path.join(os.homedir(), '.local', 'bin')];
}

/**
 * Resolve an executable by scanning PATH and the platform's usual install
 * locations. Done in pure Node rather than shelling out to which/where, so the
 * same code path works everywhere.
 */
export function which(name: string): string | null {
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...binCandidates()]) {
    for (const candidate of executableNames(name)) {
      const full = path.join(dir, candidate);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) return full;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Roots worth searching for the dictionary and the bundled voices. */
function shareRoots(openJtalkBin: string | null): string[] {
  const roots: string[] = [];
  if (openJtalkBin) {
    const prefix = path.resolve(path.dirname(openJtalkBin), '..');
    roots.push(prefix, path.join(prefix, 'share'), path.dirname(openJtalkBin));
  }
  if (isWindows) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) roots.push(path.join(base, 'open_jtalk'), path.join(base, 'OpenJTalk'));
    }
    roots.push('C:\\open_jtalk');
  } else if (isMac) {
    roots.push(
      '/opt/homebrew/opt/open-jtalk', '/usr/local/opt/open-jtalk',
      '/opt/homebrew/share/open-jtalk', '/usr/local/share/open-jtalk',
      '/opt/homebrew/share/hts-voice', '/usr/local/share/hts-voice',
    );
  } else {
    roots.push(
      '/usr/share/open_jtalk', '/usr/local/share/open_jtalk', '/usr/lib/open_jtalk',
      '/usr/share/hts-voice', '/usr/local/share/hts-voice',
      // Debian/Ubuntu ship the dictionary under mecab's tree.
      '/var/lib/mecab/dic/open-jtalk',
    );
  }
  roots.push(path.join(os.homedir(), '.local', 'share', 'open_jtalk'));
  return roots;
}

const hasDictionary = (dir: string): boolean => {
  try { return fs.statSync(path.join(dir, 'sys.dic')).isFile(); } catch { return false; }
};

export function findDictionary(openJtalkBin: string | null): string | null {
  const relatives = [
    '.', 'dic', 'naist-jdic',
    'open_jtalk_dic_utf_8-1.11', 'open_jtalk_dic_utf_8-1.10',
    path.join('open_jtalk', 'dic'), path.join('share', 'open_jtalk', 'dic'),
  ];

  for (const root of shareRoots(openJtalkBin)) {
    for (const rel of relatives) {
      const dir = path.resolve(root, rel);
      if (hasDictionary(dir)) return dir;
    }
    // Homebrew and some tarballs nest the dictionary under a version directory.
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const rel of ['dic', 'naist-jdic', '.']) {
        const dir = path.join(root, entry.name, rel);
        if (hasDictionary(dir)) return dir;
      }
    }
  }
  return null;
}

export function findVoices(openJtalkBin: string | null, extraDirs: string[] = []): VoiceInfo[] {
  const found = new Map<string, VoiceInfo>();

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.htsvoice')) {
        let key = full;
        try { key = fs.realpathSync(full); } catch { /* dangling symlink */ }
        if (!found.has(key)) {
          found.set(key, { name: path.basename(entry.name, path.extname(entry.name)), path: full });
        }
      }
    }
  };

  for (const dir of [...extraDirs, ...shareRoots(openJtalkBin)]) walk(dir, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function detect(extraVoiceDirs: string[] = []): EnginePaths {
  const openJtalk = which('open_jtalk');
  let htsEngine = which('hts_engine');
  // Some builds (Homebrew's among them) ship hts_engine beside open_jtalk.
  if (!htsEngine && openJtalk) {
    for (const candidate of executableNames('hts_engine')) {
      const sibling = path.join(path.dirname(openJtalk), candidate);
      if (fs.existsSync(sibling)) { htsEngine = sibling; break; }
    }
  }
  return {
    openJtalk,
    htsEngine,
    dictionary: findDictionary(openJtalk),
    voices: findVoices(openJtalk, extraVoiceDirs),
  };
}
