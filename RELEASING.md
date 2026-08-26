# リリース手順

macOS 版に署名と公証をするための準備と、実際のリリース手順です。
Apple Developer Program（有料）の会員であることが前提です。

## 1. Developer ID Application 証明書を作る

配布に使えるのは **Developer ID Application** です。手元にある
「Apple Development」はローカル開発用で、他人の Mac では Gatekeeper に拒否されます。

Xcode から作るのが簡単です。

1. Xcode → Settings → Accounts → Apple ID を選択 → Manage Certificates…
2. 左下の **+** → **Developer ID Application**
3. 作成されたら確認します。

```
security find-identity -v -p codesigning
```

`Developer ID Application: ... (TEAMID)` が出れば成功です。

## 2. 公証用の資格情報を用意する

App Store Connect の API キーを使う方法と、App用パスワードを使う方法があります。
手軽なのは後者です。

1. https://appleid.apple.com → サインインとセキュリティ → App用パスワード
2. パスワードを生成して控える（`xxxx-xxxx-xxxx-xxxx` 形式）
3. Team ID は https://developer.apple.com/account の Membership か、
   `security find-identity` の出力の括弧内で確認できます。

## 3. ローカルで署名・公証ビルドを作る

```
export APPLE_ID="あなたの Apple ID のメールアドレス"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run dist:mac:release
npm run verify:mac
```

`npm run verify:mac` は Gatekeeper と同じ観点で確認します。

- 署名が壊れていないか
- 署名者が Developer ID か（開発用証明書だと落ちます）
- Hardened Runtime が有効か
- 公証チケットが添付（staple）されているか
- `spctl` が `Notarized Developer ID` と判定するか

すべて ok になったものだけを配布してください。公証には数分かかります。

## 4. GitHub Actions で自動化する

タグを押すだけでビルド・署名・公証・リリース作成まで走ります。
リポジトリの Settings → Secrets and variables → Actions に次を登録してください。

| Secret | 中身 |
| --- | --- |
| `CSC_LINK` | Developer ID 証明書を `.p12` で書き出し、base64 にしたもの |
| `CSC_KEY_PASSWORD` | その `.p12` のパスワード |
| `APPLE_ID` | Apple ID のメールアドレス |
| `APPLE_APP_SPECIFIC_PASSWORD` | 手順 2 で作った App用パスワード |
| `APPLE_TEAM_ID` | Team ID |

`.p12` の書き出しは「キーチェーンアクセス」で証明書を右クリック →
「書き出す」。base64 化は次の通りです。

```
base64 -i DeveloperID.p12 | pbcopy
```

登録できたらリリースします。

```
npm version patch          # または minor / major
git push --follow-tags
```

`v*` タグで release.yml が動き、3 プラットフォームをビルドして GitHub Release を
作ります。macOS のジョブは `verify:mac` に通らなければ失敗するので、
公証されていない成果物が公開されることはありません。

## 5. Homebrew tap を更新する

リリースが終わると、Actions の成果物として `homebrew-cask` が出ます。
中の `jtalk-gui.rb` を tap リポジトリの `Casks/` に置いて push してください。
ローカルで作る場合は `npm run cask` です。

初回だけ tap リポジトリの作成が必要です。詳細は
[homebrew/README.md](homebrew/README.md) を参照してください。

## 公証がうまくいかないとき

まず診断してください。認証情報の形式を検証したうえで、Apple に実際に問い合わせます。

```
npm run check:notary
```

### `HTTP status code: 401. The account does not exist.`

署名は通っているのに公証だけ 401 になる場合、証明書ではなく
**Apple ID と App用パスワードの組み合わせ**が原因です。多い順に:

1. **App用パスワードを別の Apple ID で作った。**
   `APPLE_ID` と、パスワードを発行した Apple ID が一致している必要があります。
2. **App用パスワードを作り直した。** 古いものは無効になります。
3. **通常の Apple ID のパスワードを使っている。** 公証には使えません。
   形式が `xxxx-xxxx-xxxx-xxxx` でなければ間違いです。
4. **`APPLE_ID` が Developer Program の所属アカウントではない。**

どの Apple ID が対象かは、キーチェーンの証明書から辿れます。

```
security find-identity -v -p codesigning
```

`Developer ID Application: 名前 (TEAMID)` の TEAMID が `APPLE_TEAM_ID` と
一致しているかも確認してください。

### キーチェーンに資格情報を保存する方法

環境変数を毎回 export する代わりに、notarytool に保存できます。
保存時にその場で認証を検証するので、誤りがあればすぐ分かります。

```
xcrun notarytool store-credentials "jtalk-gui" \
  --apple-id "あなたのApple IDメール" \
  --team-id "XXXXXXXXXX" \
  --password "xxxx-xxxx-xxxx-xxxx"

export APPLE_KEYCHAIN_PROFILE="jtalk-gui"
npm run dist:mac:release
```

### App Store Connect API キーを使う方法

Apple ID 方式がどうしても通らない場合はこちらが確実です。
App Store Connect → ユーザーとアクセス → 統合 → キー で発行します。

```
export APPLE_API_KEY="/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

`APPLE_ID` 系の変数が残っているとそちらが優先されるので、
API キーに切り替えるときは `unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD` してください。

## 公証しない場合

そのままでも配布はできますが、Homebrew は cask のダウンロードを必ず quarantine
するため、利用者は初回に手動で属性を消す必要があります。

```
xattr -dr com.apple.quarantine "/Applications/JTalk GUI.app"
```
