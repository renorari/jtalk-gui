// Driven inside the renderer by `--eval`. Clicks real DOM elements and reads the
// resulting UI back, so it exercises the wiring rather than the pure functions.
(async () => {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail ?? '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const badges = () => $$('.phrase .phrase-head .sui-chip').map((n) => n.textContent);
  const phraseCount = () => $$('.phrase').length;
  const pauseCount = () => $$('.boundary.paused').length;
  // The menu lives in the main process; this is the same channel it uses.
  const menu = (action) => window.dispatchEvent(new CustomEvent('__menu', { detail: action }));

  await sleep(200);
  check('アクセント句が描画される', phraseCount() > 0, `${phraseCount()} 句`);

  // ---- accent nucleus via clicking a mora ----
  const before = badges()[0];
  const moras = $$('.phrase')[0].querySelectorAll('.mora');
  if (moras.length >= 2) {
    moras[1].click();
    await sleep(250);
    check('モーラのクリックでアクセント型が変わる', badges()[0] !== before,
      `${before} -> ${badges()[0]}`);
  }
  const afterAccent = badges()[0];

  // ---- undo / redo ----
  menu('undo');
  await sleep(250);
  check('Undo でアクセントが戻る', badges()[0] === before, `${afterAccent} -> ${badges()[0]}`);

  menu('redo');
  await sleep(250);
  check('Redo でアクセントが再適用される', badges()[0] === afterAccent, badges()[0]);

  menu('undo');
  await sleep(250);

  // ---- pause remove -> re-insert (the reported bug) ----
  const initialPauses = pauseCount();
  check('初期状態にポーズがある', initialPauses > 0, `${initialPauses} 個`);

  const removeBtn = $$('.boundary.paused .boundary-btn.pause')[0];
  if (removeBtn) {
    removeBtn.click();
    await sleep(300);
    check('ポーズを削除できる', pauseCount() === initialPauses - 1,
      `${initialPauses} -> ${pauseCount()}`);

    // The boundary must still exist so the pause can go back.
    const boundaries = $$('.boundary');
    check('削除後も境界コントロールが残る', boundaries.length > 0, `${boundaries.length} 箇所`);

    const addBtn = $$('.boundary:not(.paused) .boundary-btn.pause')[0];
    check('ポーズ挿入ボタンが存在する', !!addBtn);
    if (addBtn) {
      addBtn.click();
      await sleep(300);
      check('削除したポーズを再挿入できる', pauseCount() === initialPauses,
        `${initialPauses - 1} -> ${pauseCount()}`);
    }
  }

  // ---- undo restores pause state too ----
  menu('undo');
  await sleep(250);
  menu('undo');
  await sleep(250);
  check('Undo でポーズ操作も戻る', pauseCount() === initialPauses, `${pauseCount()} 個`);

  // ---- split / merge ----
  const phrasesBefore = phraseCount();
  const gap = $$('.phrase')[0].querySelector('.gap');
  if (gap) {
    gap.click();
    await sleep(300);
    check('区切りのクリックで分割される', phraseCount() === phrasesBefore + 1,
      `${phrasesBefore} -> ${phraseCount()}`);

    const mergeBtn = $$('.boundary:not(.paused) .boundary-btn.merge').find((b) => !b.disabled);
    if (mergeBtn) {
      mergeBtn.click();
      await sleep(300);
      check('結合ボタンでアクセント句が減る', phraseCount() === phrasesBefore,
        `${phrasesBefore + 1} -> ${phraseCount()}`);
    }
  }

  // ---- inline reading editor ----
  const firstMora = $$('.phrase')[0].querySelector('.mora');
  firstMora.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(250);
  const input = document.querySelector('.reading-input');
  check('ダブルクリックで読み編集が開く', !!input, input ? `値: ${input.value}` : '');
  if (input) {
    input.value = 'コンバンワ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(350);
    const kana = $$('.phrase')[0] ? $$('.phrase')[0].querySelectorAll('.mora') : [];
    const text = Array.from(kana).map((n) => n.querySelector('.kana').textContent).join('');
    check('読みの変更が反映される', text.startsWith('コンバンワ'), text);
  }

  // ---- script list drag to reorder ----
  menu('new-line');
  await sleep(200);
  const items = $$('#script-list li');
  check('行を追加できる', items.length === 2, `${items.length} 行`);
  if (items.length === 2) {
    const dt = new DataTransfer();
    items[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    items[0].dispatchEvent(new DragEvent('dragover', {
      bubbles: true, dataTransfer: dt, clientY: items[0].getBoundingClientRect().top + 2,
    }));
    items[0].dispatchEvent(new DragEvent('drop', {
      bubbles: true, dataTransfer: dt, clientY: items[0].getBoundingClientRect().top + 2,
    }));
    await sleep(250);
    const nums = $$('#script-list .line-text').map((n) => n.textContent);
    check('ドラッグで行を並べ替えられる', nums[0] === '（空の行）', nums.join(' | '));
  }

  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
})()
