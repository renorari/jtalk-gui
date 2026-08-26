// Regression tests for the accent editing operations.
//
// The headline case: removing a pause used to be a one-way door, because the UI hung
// the pause control off breath-group boundaries. Deleting the pause merged the two
// groups, so there was no boundary left to click. Pause controls now live on accent
// phrase boundaries, which survive the merge -- these tests pin that down.

import { detect } from '../src/main/engine/paths';
import { analyze } from '../src/main/engine/synth';
import { buildLabel } from '../src/main/engine/label';
import {
  insertPauseBefore, removePauseBefore, hasPauseBefore,
  setAccent, setPron, splitAt, mergeWithPrevious,
} from '../src/main/engine/edit';
import type { EngineConfig, NjdNode } from '../src/shared/types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const phraseTexts = (njd: NjdNode[]): string =>
  buildLabel(njd).accentPhrases.map((p) => p.moras.map((m) => m.text).join('')).join(' / ');

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

  // ---- pause remove/insert round trip ----
  {
    const { njd } = await analyze('こんにちは。今日はいい天気です。', cfg);
    const base = buildLabel(njd);
    const groups = (n: NjdNode[]): number =>
      new Set(buildLabel(n).accentPhrases.map((p) => p.breathGroup)).size;

    // The phrase right after the first pause.
    const idx = base.accentPhrases.findIndex((p) => hasPauseBefore(njd, p));
    check('初期状態にポーズがある', idx > 0, `アクセント句 ${idx}`);

    const removed = removePauseBefore(njd, base.accentPhrases[idx]);
    const afterRemove = buildLabel(removed);
    check('ポーズを削除するとブレスグループが減る',
      groups(removed) < groups(njd), `${groups(njd)} -> ${groups(removed)}`);
    check('削除後もアクセント句の数は変わらない',
      afterRemove.accentPhrases.length === base.accentPhrases.length);

    // The regression: the boundary must still be addressable after the merge.
    const target = afterRemove.accentPhrases[idx];
    check('削除後もポーズなしと判定される', !hasPauseBefore(removed, target));

    const reinserted = insertPauseBefore(removed, target);
    check('削除したポーズを再挿入できる',
      groups(reinserted) === groups(njd), `${groups(removed)} -> ${groups(reinserted)}`);
    check('再挿入後はポーズありと判定される',
      hasPauseBefore(reinserted, buildLabel(reinserted).accentPhrases[idx]));
    check('往復してもアクセント句の並びが保たれる',
      phraseTexts(reinserted) === phraseTexts(njd),
      phraseTexts(reinserted));

    // Repeat the cycle to be sure it is not a one-shot.
    let cycled = reinserted;
    for (let i = 0; i < 3; i++) {
      const phrases = buildLabel(cycled).accentPhrases;
      cycled = removePauseBefore(cycled, phrases[idx]);
      cycled = insertPauseBefore(cycled, buildLabel(cycled).accentPhrases[idx]);
    }
    check('3 往復しても壊れない', phraseTexts(cycled) === phraseTexts(njd));
  }

  // ---- pause at a boundary that never had one ----
  {
    const { njd } = await analyze('今日はいい天気ですね。', cfg);
    const base = buildLabel(njd);
    const target = base.accentPhrases[1];
    check('ポーズのない境界に新規挿入できる', !hasPauseBefore(njd, target));
    const withPause = insertPauseBefore(njd, target);
    check('新規挿入でブレスグループが増える',
      new Set(buildLabel(withPause).accentPhrases.map((p) => p.breathGroup)).size
        > new Set(base.accentPhrases.map((p) => p.breathGroup)).size);
    const back = removePauseBefore(withPause, buildLabel(withPause).accentPhrases[1]);
    check('挿入したポーズを削除して元に戻せる', phraseTexts(back) === phraseTexts(njd));
  }

  // ---- edits do not corrupt each other ----
  {
    const { njd } = await analyze('東京特許許可局。', cfg);
    const base = buildLabel(njd);
    const p0 = base.accentPhrases[0];

    const accented = setAccent(njd, p0, 2);
    check('アクセント変更後もモーラ列は不変',
      phraseTexts(accented) === phraseTexts(njd));

    const splitPoint = p0.moras.findIndex((m, i) => i > 0 && m.text !== 'ー');
    if (splitPoint > 0) {
      const split = splitAt(njd, p0, splitPoint);
      const merged = mergeWithPrevious(split, buildLabel(split).accentPhrases[1]);
      check('分割してから結合すると元に戻る', phraseTexts(merged) === phraseTexts(njd),
        phraseTexts(merged));
    }
  }

  // ---- reading edit ----
  {
    const { njd } = await analyze('東京。', cfg);
    const edited = setPron(njd, 0, 'トウキョウ');
    const phrases = buildLabel(edited).accentPhrases;
    check('読みを変更できる', phrases[0].moras.map((m) => m.text).join('') === 'トウキョウ',
      phrases[0].moras.map((m) => m.text).join(''));
    // ト / ウ / キョ / ウ — a yoon like キョ is a single mora.
    check('読みの変更でモーラ数が更新される', phrases[0].moraCount === 4,
      `${phrases[0].moraCount} モーラ`);
  }

  console.log(failures === 0 ? '\n  すべて成功\n' : `\n  ${failures} 件失敗\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
