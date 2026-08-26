// Thin wrappers around the two binaries.
//   analyze()    text   -> NJD morphemes  (open_jtalk; the audio it makes is discarded)
//   synthesize() labels -> wav            (hts_engine)

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseTextAnalysis, parseOutputLabel } from './njd';
import type { EngineConfig, NjdNode, PhonemeDuration, SynthParams } from '../../shared/types';

const execFileAsync = promisify(execFile);

const EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024 } as const;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jtalk-gui-'));
}

export interface AnalyzeResult {
  njd: NjdNode[];
  /** open_jtalk's own labels for the same text; the tests diff against these. */
  referenceLabels: string[];
}

/**
 * Run text analysis. We ask open_jtalk for a trace and ignore its audio: the trace
 * carries the NJD morphemes, which is what the accent editor lets the user change.
 */
export async function analyze(text: string, cfg: EngineConfig): Promise<AnalyzeResult> {
  if (!cfg.openJtalk) throw new Error('open_jtalk が見つかりません。設定でパスを指定してください。');
  if (!cfg.dictionary) throw new Error('辞書ディレクトリが見つかりません。設定でパスを指定してください。');
  if (!cfg.voice) throw new Error('音声モデル (.htsvoice) が選択されていません。');

  const dir = tmpdir();
  try {
    const inFile = path.join(dir, 'in.txt');
    const traceFile = path.join(dir, 'trace.txt');
    fs.writeFileSync(inFile, text.endsWith('\n') ? text : text + '\n', 'utf8');
    await execFileAsync(cfg.openJtalk, [
      '-x', cfg.dictionary,
      '-m', cfg.voice,
      '-ot', traceFile,
      inFile,
    ], EXEC_OPTS);
    const trace = fs.readFileSync(traceFile, 'utf8');
    return { njd: parseTextAnalysis(trace), referenceLabels: parseOutputLabel(trace) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Numeric hts_engine flags, in the order its --help lists them. */
export const PARAM_FLAGS: ReadonlyArray<readonly [keyof SynthParams, string]> = [
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

function paramArgs(params: SynthParams = {}): string[] {
  const args: string[] = [];
  for (const [key, flag] of PARAM_FLAGS) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isNaN(n)) continue;
    args.push(flag, String(n));
  }
  return args;
}

function assertSynthReady(cfg: EngineConfig, labels: string[]): void {
  if (!cfg.htsEngine) throw new Error('hts_engine が見つかりません。設定でパスを指定してください。');
  if (!cfg.voice) throw new Error('音声モデル (.htsvoice) が選択されていません。');
  if (!labels || labels.length === 0) throw new Error('合成するラベルがありません。');
}

/** Synthesize a wav from full-context labels. */
export async function synthesize(labels: string[], cfg: EngineConfig, params: SynthParams): Promise<Buffer> {
  assertSynthReady(cfg, labels);
  const dir = tmpdir();
  try {
    const labFile = path.join(dir, 'in.lab');
    const wavFile = path.join(dir, 'out.wav');
    fs.writeFileSync(labFile, labels.join('\n') + '\n', 'utf8');
    await execFileAsync(cfg.htsEngine!, ['-m', cfg.voice!, ...paramArgs(params), '-ow', wavFile, labFile], EXEC_OPTS);
    return fs.readFileSync(wavFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Per-phoneme durations, so the accent view can follow playback. */
export async function durations(labels: string[], cfg: EngineConfig, params: SynthParams): Promise<PhonemeDuration[]> {
  assertSynthReady(cfg, labels);
  const dir = tmpdir();
  try {
    const labFile = path.join(dir, 'in.lab');
    const durFile = path.join(dir, 'out.dur');
    fs.writeFileSync(labFile, labels.join('\n') + '\n', 'utf8');
    await execFileAsync(cfg.htsEngine!, ['-m', cfg.voice!, ...paramArgs(params), '-od', durFile, labFile], EXEC_OPTS);
    const out: PhonemeDuration[] = [];
    for (const line of fs.readFileSync(durFile, 'utf8').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      // hts_engine reports in 100 ns units.
      if (m) out.push({ start: Number(m[1]) / 1e7, end: Number(m[2]) / 1e7, label: m[3] });
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
