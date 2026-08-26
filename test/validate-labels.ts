// Regenerates full-context labels from the NJD analysis and diffs them against the
// labels open_jtalk produced for the same text. A mismatch means the port in
// src/main/engine/label.ts has drifted from the C.

import { detect } from '../src/main/engine/paths';
import { analyze } from '../src/main/engine/synth';
import { buildLabel } from '../src/main/engine/label';
import type { EngineConfig } from '../src/shared/types';

const CORPUS: string[] = [
  'こんにちは。',
  '今日はいい天気ですね。',
  'ずんだもんなのだ。',
  '東京特許許可局局長。',
  '私はコンピュータープログラムです。',
  'これはテストですか？',
  'あ、そうですか。えっと、たぶん大丈夫です。',
  '1234円です。',
  '2024年3月15日の午後3時30分に会いましょう。',
  'アクセントを変更できるGUIツールを作りました。',
  '彼女は美しい花を買った。',
  'すもももももももものうち。',
  'その本を読んでいるところです。',
  '日本語の音声合成は難しい。',
  'ぼくの名前は中野です、よろしく。',
  'シャンプーとリンスを買ってきて。',
  'ファイルをダウンロードしています。',
  'ヴァイオリンとチェロのデュエット。',
  'きっぷを買って、でんしゃに乗る。',
  'そうですね……たぶん、そうだと思います。',
  '一二三四五六七八九十。',
  'えっ、本当に？',
  'A B C です。',
  'パーセントは％と書きます。',
  '長い文章を入力すると、複数のブレスグループに分かれて、それぞれが独立したアクセント句を持つようになります。',
  'お母さんとお父さんと弟と妹。',
  '橋の端を箸を持って歩く。',
  '生年月日を教えてください。',
  '株式会社ほげほげの山田太郎と申します。',
  'ちょっと待って！',
  'コーヒーを一杯ください。',
  'サッカーとバスケットボール、どっちが好き？',
  'その提案には賛成しかねます。',
  '十時十分前に集合してください。',
  'ニュースを聞いて驚いた。',
];

interface Failure { text: string; reason: string; got?: string; want?: string }

async function main(): Promise<void> {
  const d = detect();
  const voice = d.voices.find((v) => v.name === 'mei_normal') ?? d.voices[0];
  if (!d.openJtalk || !d.dictionary || !voice) {
    console.error('open_jtalk / 辞書 / htsvoice が見つからないため検証をスキップします');
    process.exit(2);
  }
  const cfg: EngineConfig = {
    openJtalk: d.openJtalk, htsEngine: d.htsEngine,
    dictionary: d.dictionary, voice: voice.path,
  };

  let pass = 0;
  const failures: Failure[] = [];

  for (const text of CORPUS) {
    const { njd, referenceLabels } = await analyze(text, cfg);
    const { features } = buildLabel(njd);

    if (features.length !== referenceLabels.length) {
      failures.push({ text, reason: `ラベル数 ${features.length} != ${referenceLabels.length}` });
      continue;
    }
    let diff: Failure | null = null;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== referenceLabels[i]) {
        diff = { text, reason: `${i} 行目が不一致`, got: features[i], want: referenceLabels[i] };
        break;
      }
    }
    if (diff) failures.push(diff);
    else pass++;
  }

  console.log(`\n  ${pass}/${CORPUS.length} 文が open_jtalk の出力と完全一致\n`);
  for (const f of failures) {
    console.log(`  FAIL  ${f.text}`);
    console.log(`        ${f.reason}`);
    if (f.want) {
      console.log(`        want: ${f.want}`);
      console.log(`        got : ${f.got}`);
    }
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
