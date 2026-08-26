# JTalk GUI

Open JTalk と hts_engine を使った、アクセントを編集できる日本語音声合成 GUI（VOICEVOX ライク）。

テキストを解析してアクセント句に分け、アクセント核の位置・アクセント句の分割/結合・
ポーズの挿入をエディタ上で編集し、その結果を音声として再生・書き出しできます。

## 仕組み

VOICEVOX のようなアクセント編集を Open JTalk で実現するために、
**フルコンテキストラベルの生成処理を TypeScript に移植** しています。

```
テキスト
  │  open_jtalk -ot        （形態素解析のみ利用）
  ▼
NJD 形態素列  ── ユーザーが pron / アクセント核 / chain_flag を編集
  │  src/main/engine/label.ts    （njd2jpcommon + jpcommon_label の移植）
  ▼
フルコンテキストラベル
  │  hts_engine -m voice.htsvoice
  ▼
WAV
```

open_jtalk が内部で行う「テキスト→ラベル」の後半部分を自前で持つことで、
アクセントを変えたラベルを組み立て直して hts_engine に直接渡せます。

ラベルの仕様は HTS Working Group の
*"An example of context-dependent label format for HMM-based speech synthesis in Japanese"*
（同梱の `lab_format.pdf`）に準拠しています。

### 移植の正しさ

`test/validate-labels.ts` が 35 文について、移植版が生成したラベルと
open_jtalk 自身が出力したラベルを 1 行ずつ比較します。現在は全文完全一致です。

```
npm test
```

## 必要なもの

- Node.js 20 以上
- `open_jtalk` と `hts_engine`、辞書、`.htsvoice`

macOS (Homebrew) なら次で一式入ります。

```
brew install open-jtalk
```

パスは自動検出します。見つからない場合や別の場所に入れている場合は、
アプリの「設定」から個別に指定できます。`.htsvoice` を置いたディレクトリを
追加すると、その中のモデルも選択肢に出ます。

## 使い方

```
npm install
npm start
```

| 操作 | 効果 |
| --- | --- |
| モーラをクリック | そのモーラをアクセント核にする（もう一度で平板に戻す） |
| モーラ間の区切りをクリック | そこでアクセント句を分割 |
| アクセント句の間の区切りをクリック | 前のアクセント句と結合 |
| ブレスグループ間のチップ | ポーズの挿入 / 削除 |
| Enter | テキストを解析（Shift+Enter で改行） |
| Space | 再生 / 停止 |

アクセント句の破線は形態素の境界で、分割の目安になります。
分割は形態素の途中でも可能で、その場合は形態素自体を 2 つに分けます。
ただし長音「ー」は直前の音素を引き継ぐため、その直前では分割できません。

「保存」で台本とアクセント編集を JSON に保存でき、「開く」で復元できます。
「ラベル書き出し」は編集後のフルコンテキストラベルを `.lab` として出力するので、
他の HTS 系ツールにも渡せます。

## パラメータ

hts_engine のオプションをそのまま渡しています。

| 表示 | オプション | 備考 |
| --- | --- | --- |
| 話速 | `-r` | **大きいほど速い**（レートであって長さではない） |
| 音高 | `-fm` | 半音単位 |
| 抑揚 | `-jf` | 対数 F0 の GV 重み |
| 音量 | `-g` | dB |
| 声質 α | `-a` | 全極通過定数 |
| ポストフィルタ | `-b` | |
| 有声/無声閾値 | `-u` | |
| スペクトル GV | `-jm` | |

## 開発

```
npm run build      # tsc + esbuild + アセットコピー
npm start          # ビルドして起動
npm test           # ラベル移植の検証
npm run typecheck
node dist-tools/test/smoke-pipeline.js   # 解析→編集→合成の通し確認
```

`src/main/engine/tables.ts` は Open JTalk の C ヘッダから生成しています。
手で編集せず、生成し直してください。

```
npm run gen-tables -- /path/to/open_jtalk-1.11
```

> VS Code の統合ターミナルは `ELECTRON_RUN_AS_NODE=1` を設定するため、
> `electron .` を直接叩くと起動に失敗します。`tools/start.mjs`
> （`npm start` が使用）はこれを取り除いてから起動します。

## 構成

```
src/
  shared/types.ts        主要な型
  main/
    main.ts              Electron メイン / IPC
    preload.ts           contextBridge
    engine/
      tables.ts          Open JTalk のルール表（自動生成）
      label.ts           NJD → フルコンテキストラベル（C からの移植）
      njd.ts             open_jtalk の解析結果のパース
      edit.ts            アクセント編集操作
      synth.ts           open_jtalk / hts_engine の実行
      paths.ts           バイナリ・辞書・音声モデルの検出
  renderer/              UI（Sashimi UI + 自前のアクセントエディタ）
```

## ライセンス

このリポジトリのコードは BSD-3-Clause です。
`src/main/engine/label.ts` と `tables.ts` は Open JTalk（BSD-3-Clause,
名古屋工業大学）からの移植を含みます。
UI には [Sashimi UI](https://github.com/yuto-hasegawa/sashimi-ui)（MIT）を使用しています。

Open JTalk 本体・辞書・音声モデルは同梱していません。各配布元のライセンスに従ってください。
