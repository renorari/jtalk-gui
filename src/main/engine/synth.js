'use strict';
// Thin wrappers around the two binaries.
//   analyze():   text  -> NJD morphemes (open_jtalk, output discarded)
//   synthesize(): labels -> wav        (hts_engine)

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { parseTextAnalysis, parseOutputLabel } = require('./njd');

const execFileAsync = promisify(execFile);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jtalk-gui-'));
}

/**
 * Run text analysis. We ask open_jtalk for a trace and throw away the audio; the
 * trace carries the NJD morphemes we want to let the user edit.
 */
async function analyze(text, cfg) {
  if (!cfg.openJtalk) throw new Error('open_jtalk が見つかりません。設定でパスを指定してください。');
  if (!cfg.dictionary) throw new Error('辞書ディレクトリが見つかりません。設定でパスを指定してください。');
  if (!cfg.voice) throw new Error('音声モデル (.htsvoice) が選択されていません。');

  const dir = tmpdir();
  const inFile = path.join(dir, 'in.txt');
  const traceFile = path.join(dir, 'trace.txt');
  try {
    fs.writeFileSync(inFile, text.endsWith('\n') ? text : text + '\n', 'utf8');
    await execFileAsync(cfg.openJtalk, [
      '-x', cfg.dictionary,
      '-m', cfg.voice,
      '-ot', traceFile,
      inFile,
    ], { maxBuffer: 32 * 1024 * 1024 });
    const trace = fs.readFileSync(traceFile, 'utf8');
    return { njd: parseTextAnalysis(trace), referenceLabels: parseOutputLabel(trace) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Numeric hts_engine flags, in the order the CLI documents them. */
const PARAM_FLAGS = [
  ['samplingFrequency', '-s'],
  ['framePeriod', '-p'],
  ['allPassConstant', '-a'],
  ['postfilter', '-b'],
  ['speechSpeedRate', '-r'],
  ['additionalHalfTone', '-fm'],
  ['voicedUnvoicedThreshold', '-u'],
  ['gvWeightSpectrum', '-jm'],
  ['gvWeightLogF0', '-jf'],
  ['volume', '-g'],
];

function paramArgs(params = {}) {
  const args = [];
  for (const [key, flag] of PARAM_FLAGS) {
    const v = params[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isNaN(n)) continue;
    args.push(flag, String(n));
  }
  return args;
}

/**
 * Synthesize a wav from full-context labels.
 * @param {string[]} labels
 * @returns {Promise<Buffer>} wav bytes
 */
async function synthesize(labels, cfg, params) {
  if (!cfg.htsEngine) throw new Error('hts_engine が見つかりません。設定でパスを指定してください。');
  if (!cfg.voice) throw new Error('音声モデル (.htsvoice) が選択されていません。');
  if (!labels || labels.length === 0) throw new Error('合成するラベルがありません。');

  const dir = tmpdir();
  const labFile = path.join(dir, 'in.lab');
  const wavFile = path.join(dir, 'out.wav');
  try {
    fs.writeFileSync(labFile, labels.join('\n') + '\n', 'utf8');
    await execFileAsync(cfg.htsEngine, [
      '-m', cfg.voice,
      ...paramArgs(params),
      '-ow', wavFile,
      labFile,
    ], { maxBuffer: 64 * 1024 * 1024 });
    return fs.readFileSync(wavFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Per-phoneme durations, used to line the accent view up with playback. */
async function durations(labels, cfg, params) {
  const dir = tmpdir();
  const labFile = path.join(dir, 'in.lab');
  const durFile = path.join(dir, 'out.dur');
  try {
    fs.writeFileSync(labFile, labels.join('\n') + '\n', 'utf8');
    await execFileAsync(cfg.htsEngine, [
      '-m', cfg.voice,
      ...paramArgs(params),
      '-od', durFile,
      labFile,
    ], { maxBuffer: 64 * 1024 * 1024 });
    const out = [];
    for (const line of fs.readFileSync(durFile, 'utf8').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (m) out.push({ start: Number(m[1]) / 1e7, end: Number(m[2]) / 1e7, label: m[3] });
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { analyze, synthesize, durations, PARAM_FLAGS };
