// Diagnoses notarization credentials before a release build wastes ten minutes
// signing an app it cannot notarize.
//
//   npm run check:notary
//
// Secrets are never printed; only their shape is reported.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';

let problems = 0;
const ok = (msg, detail = '') => console.log(`  ok    ${msg}${detail ? ` — ${detail}` : ''}`);
const bad = (msg, detail = '') => { problems++; console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`); };
const note = (msg) => console.log(`        ${msg}`);

const env = process.env;

console.log('\n認証情報\n');

// --- which credential set is in play -------------------------------------
const hasAppleId = !!(env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD);
const hasApiKey = !!(env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER);
const hasProfile = !!env.APPLE_KEYCHAIN_PROFILE;

if (!hasAppleId && !hasApiKey && !hasProfile) {
  bad('認証情報が一つも設定されていません');
  note('APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID を export してください。');
  process.exit(1);
}

// electron-builder checks these in order, so a half-set Apple ID pair wins over
// a complete API key set.
if (hasAppleId && hasApiKey) {
  bad('Apple ID と API キーの両方が設定されています');
  note('electron-builder は Apple ID を優先します。使わない方は unset してください。');
}

// --- Apple ID route -------------------------------------------------------
if (hasAppleId) {
  const appleId = env.APPLE_ID ?? '';
  const password = env.APPLE_APP_SPECIFIC_PASSWORD ?? '';
  const teamId = env.APPLE_TEAM_ID ?? '';

  if (!appleId) bad('APPLE_ID が未設定');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(appleId)) {
    bad('APPLE_ID がメールアドレスの形式ではありません', appleId);
    note('Team ID ではなく、Developer Program に登録した Apple ID のメールアドレスです。');
  } else ok('APPLE_ID', appleId);

  if (!password) bad('APPLE_APP_SPECIFIC_PASSWORD が未設定');
  else if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(password)) {
    bad('APPLE_APP_SPECIFIC_PASSWORD が App用パスワードの形式ではありません',
      `${password.length} 文字`);
    note('形式は xxxx-xxxx-xxxx-xxxx（小文字とハイフン）です。');
    note('通常の Apple ID のパスワードでは公証できません。');
    note('appleid.apple.com → サインインとセキュリティ → App用パスワード で作成してください。');
  } else ok('APPLE_APP_SPECIFIC_PASSWORD', '形式は正しい');

  if (!teamId) bad('APPLE_TEAM_ID が未設定');
  else if (!/^[A-Z0-9]{10}$/.test(teamId)) bad('APPLE_TEAM_ID が 10 桁の英数字ではありません', teamId);
  else ok('APPLE_TEAM_ID', teamId);

  // --- does the team match a Developer ID certificate we actually have? ---
  let identities = '';
  try {
    identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
  } catch { /* keychain unavailable */ }

  const devIds = [...identities.matchAll(/"Developer ID Application: (.+?) \(([A-Z0-9]{10})\)"/g)]
    .map((m) => ({ name: m[1], team: m[2] }));

  if (devIds.length === 0) {
    bad('Developer ID Application 証明書が見つかりません');
    note('Xcode → Settings → Accounts → Manage Certificates → + から作成してください。');
  } else {
    ok('Developer ID 証明書', devIds.map((d) => `${d.name} (${d.team})`).join(', '));
    if (teamId && !devIds.some((d) => d.team === teamId)) {
      bad('APPLE_TEAM_ID が証明書の Team ID と一致しません');
      note(`証明書側: ${devIds.map((d) => d.team).join(', ')} / 環境変数: ${teamId}`);
    }
  }

  // --- ask Apple directly ------------------------------------------------
  if (appleId && password && teamId) {
    console.log('\nApple に問い合わせ中…\n');
    try {
      execFileSync('xcrun', [
        'notarytool', 'history',
        '--apple-id', appleId,
        '--team-id', teamId,
        '--password', password,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      ok('公証サービスへの認証に成功しました');
    } catch (e) {
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      bad('公証サービスへの認証に失敗しました');
      note(out.trim().split('\n').slice(0, 4).join('\n        '));

      if (/does not exist|Unable to authenticate|401/i.test(out)) {
        note('');
        note('よくある原因:');
        note('  1. App用パスワードを、APPLE_ID とは別の Apple ID で作成した');
        note('  2. App用パスワードを作り直して古いものが無効になっている');
        note('  3. APPLE_ID が Developer Program の所属アカウントではない');
        note('  4. 通常のパスワードを使っている（App用パスワードが必要）');
      } else if (/Team ID|not associated/i.test(out)) {
        note('この Apple ID はその Team に所属していない可能性があります。');
      }
    }
  }
}

// --- API key route --------------------------------------------------------
if (hasApiKey && !hasAppleId) {
  const key = env.APPLE_API_KEY ?? '';
  if (!key) bad('APPLE_API_KEY が未設定');
  else if (!fs.existsSync(key)) bad('APPLE_API_KEY のファイルが見つかりません', key);
  else ok('APPLE_API_KEY', key);
  env.APPLE_API_KEY_ID ? ok('APPLE_API_KEY_ID', env.APPLE_API_KEY_ID) : bad('APPLE_API_KEY_ID が未設定');
  env.APPLE_API_ISSUER ? ok('APPLE_API_ISSUER', env.APPLE_API_ISSUER) : bad('APPLE_API_ISSUER が未設定');
}

if (hasProfile) ok('APPLE_KEYCHAIN_PROFILE', env.APPLE_KEYCHAIN_PROFILE);

console.log(problems === 0
  ? '\n公証できる状態です。npm run dist:mac:release を実行してください。\n'
  : `\n${problems} 件の問題があります。\n`);
process.exit(problems ? 1 : 0);
