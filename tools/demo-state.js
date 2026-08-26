// Drives the renderer into the state used for the README screenshot, so the
// image can be regenerated after a UI change instead of being re-staged by hand.
//
//   node tools/start.mjs --eval tools/demo-state.js --capture docs/screenshot.png
//
// The two edits below are deliberate: they show accent editing being used, not
// just Open JTalk's own output.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const kanaOf = (phrase) =>
    Array.from(phrase.querySelectorAll('.mora .kana')).map((n) => n.textContent).join('');

  const TEXT = '春の風は、青々と晴れた空を渡っていました。';

  // Wait out the app's own startup first. It seeds a line and analyses it; if
  // that analysis is still in flight it resolves later and overwrites
  // everything set up here. Engine discovery alone takes several seconds once
  // a lot of voices are installed, so wait for the analysis to have *finished*:
  // phrases on screen, the analyse button re-enabled, and a settled status.
  const idle = () =>
    $$('.phrase').length > 0
    && !document.getElementById('btn-analyze').disabled
    && /ラベル/.test(document.getElementById('status').textContent);
  for (let i = 0; i < 300 && !idle(); i++) await sleep(100);
  if (!idle()) return { error: '起動処理が終わりませんでした' };
  await sleep(500);

  const input = document.getElementById('text-input');
  input.value = TEXT;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('btn-analyze').click();

  // Wait for THIS text's analysis to land. Waiting for "any phrase" would pass
  // instantly, because the seeded line is already on screen.
  const ready = () => $$('.phrase').some((p) => kanaOf(p) === 'ハルノ');
  for (let i = 0; i < 60 && !ready(); i++) await sleep(100);
  if (!ready()) return { error: '解析が完了しませんでした' };
  await sleep(200);

  const before = $$('.phrase').map((p) => `${kanaOf(p)}:${p.querySelector('.sui-chip').textContent}`);

  // 1. ハレタ: Open JTalk says 2型; 1型 is the reading we want here.
  const hareta = $$('.phrase').find((p) => kanaOf(p) === 'ハレタ');
  if (hareta) {
    hareta.querySelectorAll('.mora')[0].click();
    await sleep(250);
  }

  // 2. Add a pause before ワタッテ, which the text has no punctuation for.
  const watatte = $$('.phrase').find((p) => kanaOf(p) === 'ワタッテ');
  const boundary = watatte?.previousElementSibling;
  if (boundary?.classList.contains('boundary')) {
    boundary.querySelector('.boundary-btn.pause').click();
    await sleep(300);
  }

  // Leave the shot clean: no focus ring, and a status line that describes the
  // document rather than the last action taken.
  document.activeElement?.blur?.();
  const phrases = $$('.phrase').length;
  const status = document.getElementById('status');
  status.textContent = `${phrases} アクセント句`;
  status.classList.remove('error');
  await sleep(200);

  return {
    before,
    after: $$('.phrase').map((p) => `${kanaOf(p)}:${p.querySelector('.sui-chip').textContent}`),
    pauses: $$('.boundary.paused').length,
  };
})()
