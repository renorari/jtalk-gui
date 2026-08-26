'use strict';
// Locates the open_jtalk binary, its dictionary, hts_engine and the .htsvoice files.
// Everything is overridable from the settings UI; these are just the defaults we probe.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN_CANDIDATES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];

function which(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch { /* not on PATH */ }
  for (const dir of BIN_CANDIDATES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The dictionary lives next to the install prefix, not the binary.
function findDictionary(openJtalkBin) {
  const roots = [];
  if (openJtalkBin) roots.push(path.resolve(path.dirname(openJtalkBin), '..'));
  roots.push('/opt/homebrew/opt/open-jtalk', '/usr/local/opt/open-jtalk',
             '/usr/share/open_jtalk', '/usr/local/share/open_jtalk', '/opt/homebrew/share/open-jtalk');
  for (const root of roots) {
    for (const rel of ['dic', 'open_jtalk_dic_utf_8-1.11', path.join('share', 'open_jtalk', 'dic')]) {
      const p = path.join(root, rel);
      if (fs.existsSync(path.join(p, 'sys.dic'))) return p;
    }
    // Homebrew keeps it under the versioned Cellar directory.
    try {
      for (const entry of fs.readdirSync(root)) {
        const p = path.join(root, entry, 'dic');
        if (fs.existsSync(path.join(p, 'sys.dic'))) return p;
      }
    } catch { /* not a directory */ }
  }
  return null;
}

function findVoices(openJtalkBin) {
  const roots = [];
  if (openJtalkBin) roots.push(path.resolve(path.dirname(openJtalkBin), '..'));
  roots.push('/opt/homebrew/opt/open-jtalk', '/usr/local/opt/open-jtalk',
             '/usr/share/hts-voice', '/usr/local/share/hts-voice', '/opt/homebrew/share/hts-voice');

  const found = new Map(); // realpath -> {name, path}
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.htsvoice')) {
        const real = fs.realpathSync(p);
        if (!found.has(real)) {
          found.set(real, { name: path.basename(e.name, '.htsvoice'), path: p });
        }
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function detect() {
  const openJtalk = which('open_jtalk');
  let htsEngine = which('hts_engine');
  // Homebrew's open-jtalk ships hts_engine in the same bin directory.
  if (!htsEngine && openJtalk) {
    const sibling = path.join(path.dirname(openJtalk), 'hts_engine');
    if (fs.existsSync(sibling)) htsEngine = sibling;
  }
  return {
    openJtalk,
    htsEngine,
    dictionary: findDictionary(openJtalk),
    voices: findVoices(openJtalk),
  };
}

module.exports = { detect, findVoices, findDictionary, which };
