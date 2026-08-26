// End-to-end check of the edit pipeline without the GUI:
//   analyze -> edit accent / split / merge -> rebuild labels -> synthesize wav.
// Verifies that edits actually reach the audio, not just the label strings.

import { detect } from '../src/main/engine/paths';
import { analyze, synthesize } from '../src/main/engine/synth';
import { buildLabel } from '../src/main/engine/label';
import { setAccent, splitAt, mergeWithPrevious, insertPauseBefore, pitchPattern } from '../src/main/engine/edit';
import { DEFAULT_PARAMS } from '../src/shared/types';
import type { EngineConfig } from '../src/shared/types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** Read the accent phrase field (F:) out of a label line. */
function accentField(label: string): string {
  return label.match(/\/F:([^/]*)/)?.[1] ?? '';
}

function isWav(buf: Buffer): boolean {
  return buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

async function main(): Promise<void> {
  const d = detect();
  const voice = d.voices.find((v) => v.name === 'mei_normal') ?? d.voices[0];
  if (!d.openJtalk || !d.dictionary || !voice) {
    console.error('エンジンが見つからないためスキップします');
    process.exit(2);
  }
  const cfg: EngineConfig = {
    openJtalk: d.openJtalk, htsEngine: d.htsEngine, dictionary: d.dictionary, voice: voice.path,
  };

  const text = '今日はいい天気ですね。';
  const { njd } = await analyze(text, cfg);
  const base = buildLabel(njd);

  console.log(`\n  "${text}"`);
  console.log(`  ${base.accentPhrases.length} アクセント句: ` +
    base.accentPhrases.map((p) => `${p.moras.map((m) => m.text).join('')}[${p.accent}]`).join(' / '));
  console.log();

  check('アクセント句が得られる', base.accentPhrases.length > 0);
  check('ラベルが得られる', base.features.length > 0);

  // --- accent nucleus ---
  const target = base.accentPhrases[0];
  const moved = buildLabel(setAccent(njd, target, target.accent === 1 ? 3 : 1));
  check('アクセント核の変更がラベルに反映される',
    accentField(moved.features[1]) !== accentField(base.features[1]),
    `${accentField(base.features[1])} -> ${accentField(moved.features[1])}`);
  check('アクセント核を変えてもモーラ数は不変',
    moved.accentPhrases[0].moraCount === target.moraCount);

  // --- heiban ---
  const flat = buildLabel(setAccent(njd, target, 0));
  check('平板 (0型) に設定できる', flat.accentPhrases[0].accent === 0);

  // --- split ---
  // A phrase can never begin with a long vowel, so pick a boundary that is not one.
  const splitPoint = target.moras.findIndex((m, i) => i > 0 && m.text !== 'ー');
  if (splitPoint > 0) {
    const split = buildLabel(splitAt(njd, target, splitPoint));
    check('アクセント句を分割できる',
      split.accentPhrases.length === base.accentPhrases.length + 1,
      `${target.moras.map((m) => m.text).join('')} を ${splitPoint} で分割: ` +
      `${base.accentPhrases.length} -> ${split.accentPhrases.length}`);
    check('分割してもモーラ総数は保存される',
      split.accentPhrases.reduce((s, p) => s + p.moraCount, 0)
        === base.accentPhrases.reduce((s, p) => s + p.moraCount, 0));
  }

  // Long vowels copy the preceding phoneme, so they may not lead an accent phrase.
  const longVowelAt = target.moras.findIndex((m, i) => i > 0 && m.text === 'ー');
  if (longVowelAt > 0) {
    const refused = buildLabel(splitAt(njd, target, longVowelAt));
    check('長音の前では分割しない',
      refused.accentPhrases.length === base.accentPhrases.length);
  }

  // --- merge ---
  if (base.accentPhrases.length >= 2) {
    const merged = buildLabel(mergeWithPrevious(njd, base.accentPhrases[1]));
    check('アクセント句を結合できる',
      merged.accentPhrases.length === base.accentPhrases.length - 1,
      `${base.accentPhrases.length} -> ${merged.accentPhrases.length}`);
  }

  // --- pause / breath group ---
  if (base.accentPhrases.length >= 2) {
    const paused = buildLabel(insertPauseBefore(njd, base.accentPhrases[1]));
    const groups = new Set(paused.accentPhrases.map((p) => p.breathGroup)).size;
    const before = new Set(base.accentPhrases.map((p) => p.breathGroup)).size;
    check('ポーズ挿入でブレスグループが増える', groups > before, `${before} -> ${groups}`);
    check('ポーズが pau としてラベルに現れる', paused.features.some((f) => f.startsWith('pau') || f.includes('-pau+')));
  }

  // --- pitch pattern ---
  check('平板型: 1モーラ目が低く以降高い',
    JSON.stringify(pitchPattern(0, 4)) === JSON.stringify([false, true, true, true]));
  check('1型: 1モーラ目のみ高い',
    JSON.stringify(pitchPattern(1, 4)) === JSON.stringify([true, false, false, false]));
  check('3型: 2-3モーラ目が高い',
    JSON.stringify(pitchPattern(3, 4)) === JSON.stringify([false, true, true, false]));

  // --- synthesis ---
  const wavBase = await synthesize(base.features, cfg, DEFAULT_PARAMS);
  const wavMoved = await synthesize(moved.features, cfg, DEFAULT_PARAMS);
  check('WAV が生成される', isWav(wavBase), `${wavBase.length} bytes`);
  check('アクセントを変えると音声が変わる', !wavBase.equals(wavMoved));

  // --- parameters reach the engine ---
  // hts_engine's -r is a rate, not a duration: larger is faster, so audio gets shorter.
  const fast = await synthesize(base.features, cfg, { ...DEFAULT_PARAMS, speechSpeedRate: 2.0 });
  const slow = await synthesize(base.features, cfg, { ...DEFAULT_PARAMS, speechSpeedRate: 0.5 });
  check('話速を上げると音声が短くなる', fast.length < wavBase.length,
    `${wavBase.length} -> ${fast.length} bytes`);
  check('話速を下げると音声が長くなる', slow.length > wavBase.length,
    `${wavBase.length} -> ${slow.length} bytes`);

  console.log(failures === 0 ? '\n  すべて成功\n' : `\n  ${failures} 件失敗\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
