// Renderer: script list, accent editor, parameter panel, playback, undo/redo.
// All engine work happens in the main process; this talks to it through window.api.

import type {
  AccentPhrase, EngineConfig, EnginePaths, MenuAction, NjdNode, SynthParams, Utterance, VoiceInfo,
} from '../shared/types';
import { DEFAULT_PARAMS } from '../shared/types';
import {
  setAccent, setPron, mergeWithPrevious, splitAt,
  insertPauseBefore, removePauseBefore, hasPauseBefore, pitchPattern,
} from '../main/engine/edit';

interface Settings {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voice: string | null;
  extraVoiceDirs: string[];
}

interface DetectResult extends EnginePaths {
  settings: Settings;
  /** The user's system accent colour as #rrggbb, when the platform reports one. */
  accentColor: string | null;
}

interface Api {
  platform: string;
  detect(): Promise<DetectResult>;
  saveSettings(s: Partial<Settings>): Promise<DetectResult>;
  analyze(text: string, cfg: Partial<EngineConfig>): Promise<{ njd: NjdNode[]; phrases: AccentPhrase[]; features: string[] }>;
  rebuild(njd: NjdNode[]): Promise<{ phrases: AccentPhrase[]; features: string[] }>;
  synthesize(features: string[], cfg: Partial<EngineConfig>, params: SynthParams): Promise<ArrayBuffer>;
  saveWav(data: ArrayBuffer, defaultName: string): Promise<string | null>;
  saveWavBatch(items: { name: string; data: ArrayBuffer }[]): Promise<{ dir: string; count: number } | null>;
  saveText(text: string, defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  writeText(filePath: string, text: string): Promise<string>;
  openText(filters: { name: string; extensions: string[] }[]): Promise<{ path: string; text: string } | null>;
  readText(filePath: string): Promise<{ path: string; text: string } | null>;
  pickPath(kind: 'file' | 'directory'): Promise<string | null>;
  confirm(message: string, detail: string): Promise<boolean>;
  setDirty(dirty: boolean): void;
  pathForFile(file: File): string;
  onMenuAction(cb: (action: MenuAction) => void): void;
  onAccentColor(cb: (color: string | null) => void): void;
}

declare global {
  interface Window { api: Api }
}

const api = window.api;

// ---------- element helpers ----------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が見つかりません`);
  return el as T;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---------- state ----------

interface State {
  utterances: Utterance[];
  selected: number;
  paths: DetectResult | null;
  voice: string | null;
  filePath: string | null;
  dirty: boolean;
  playing: boolean;
  busy: boolean;
  /** njd index of the word whose reading is being edited inline, if any. */
  editingWord: number | null;
}

const state: State = {
  utterances: [],
  selected: -1,
  paths: null,
  voice: null,
  filePath: null,
  dirty: false,
  playing: false,
  busy: false,
  editingWord: null,
};

let nextId = 1;
const makeId = (): string => `u${nextId++}`;

const current = (): Utterance | null => state.utterances[state.selected] ?? null;

function config(): Partial<EngineConfig> {
  const u = current();
  return { voice: u?.voice ?? state.voice };
}

// ---------- undo / redo ----------

interface Snapshot { utterances: Utterance[]; selected: number }

const HISTORY_LIMIT = 200;

const history: { past: Snapshot[]; future: Snapshot[]; lastLabel: string; lastAt: number } = {
  past: [], future: [], lastLabel: '', lastAt: 0,
};

const snapshot = (): Snapshot => ({
  utterances: structuredClone(state.utterances),
  selected: state.selected,
});

/**
 * Record the state *before* a change.
 *
 * `coalesceMs` merges rapid repeats of the same kind of edit into one undo step,
 * so typing a word or dragging a slider does not fill the history with keystrokes.
 */
function pushHistory(label: string, coalesceMs = 0): void {
  const now = Date.now();
  if (coalesceMs > 0 && label === history.lastLabel && now - history.lastAt < coalesceMs) {
    history.lastAt = now;
    markDirty();
    return;
  }
  history.past.push(snapshot());
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future.length = 0;
  history.lastLabel = label;
  history.lastAt = now;
  markDirty();
}

function applySnapshot(s: Snapshot): void {
  state.utterances = s.utterances;
  state.selected = Math.min(s.selected, state.utterances.length - 1);
  state.editingWord = null;
  syncTextInput();
  renderScriptList();
  renderAccent();
  renderParams();
  updateButtons();
}

function undo(): void {
  if (history.past.length === 0) { setStatus('取り消せる操作がありません'); return; }
  history.future.push(snapshot());
  applySnapshot(history.past.pop()!);
  history.lastLabel = '';
  markDirty();
  setStatus('取り消しました');
}

function redo(): void {
  if (history.future.length === 0) { setStatus('やり直せる操作がありません'); return; }
  history.past.push(snapshot());
  applySnapshot(history.future.pop()!);
  history.lastLabel = '';
  markDirty();
  setStatus('やり直しました');
}

function markDirty(): void {
  if (!state.dirty) {
    state.dirty = true;
    api.setDirty(true);
  }
  updateTitle();
}

function markClean(): void {
  state.dirty = false;
  api.setDirty(false);
  updateTitle();
}

/** Basename of a path, tolerating both separators so Windows paths work too. */
const baseName = (p: string): string => p.split(/[/\\]/).pop() ?? p;

function updateTitle(): void {
  const name = state.filePath ? baseName(state.filePath) : '無題';
  document.title = `${state.dirty ? '● ' : ''}${name} — JTalk GUI`;
}

// ---------- system accent colour ----------

const relativeLuminance = (hex: string): number => {
  const to = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * to(0) + 0.7152 * to(1) + 0.0722 * to(2);
};

/**
 * Re-point Sashimi's key colour at the accent colour chosen in System Settings, and
 * derive the secondary/tertiary tints from it so the theme stays coherent.
 */
function applyAccentColor(color: string | null): void {
  const root = document.documentElement;
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
    root.style.removeProperty('--sui-color-key-primary');
    root.style.removeProperty('--sui-color-on-key-primary');
    root.style.removeProperty('--sui-color-key-secondary');
    root.style.removeProperty('--sui-color-key-tertiary');
    return;
  }
  root.style.setProperty('--sui-color-key-primary', color);
  root.style.setProperty('--sui-color-on-key-primary',
    relativeLuminance(color) > 0.55 ? '#000000' : '#ffffff');
  root.style.setProperty('--sui-color-key-secondary',
    `color-mix(in srgb, ${color} 70%, var(--sui-color-surface))`);
  root.style.setProperty('--sui-color-key-tertiary',
    `color-mix(in srgb, ${color} 18%, var(--sui-color-surface))`);
}

// ---------- parameter definitions ----------

interface ParamDef {
  key: keyof SynthParams;
  label: string;
  min: number;
  max: number;
  step: number;
  desc: string;
  format?: (v: number) => string;
}

const PARAM_DEFS: ParamDef[] = [
  { key: 'speechSpeedRate', label: '話速', min: 0.2, max: 3, step: 0.01, desc: '大きいほど速い (-r)' },
  { key: 'additionalHalfTone', label: '音高', min: -12, max: 12, step: 0.1, desc: '半音単位のシフト (-fm)' },
  { key: 'gvWeightLogF0', label: '抑揚', min: 0, max: 3, step: 0.01, desc: 'F0 の GV 重み (-jf)' },
  { key: 'volume', label: '音量', min: -20, max: 20, step: 0.1, desc: 'dB (-g)', format: (v) => `${v.toFixed(1)} dB` },
  { key: 'allPassConstant', label: '声質 α', min: 0, max: 1, step: 0.01, desc: '声道長に相当 (-a)' },
  { key: 'postfilter', label: 'ポストフィルタ', min: 0, max: 1, step: 0.01, desc: '明瞭さ (-b)' },
  { key: 'voicedUnvoicedThreshold', label: '有声/無声閾値', min: 0, max: 1, step: 0.01, desc: 'かすれ具合 (-u)' },
  { key: 'gvWeightSpectrum', label: 'スペクトル GV', min: 0, max: 3, step: 0.01, desc: '声のはっきりさ (-jm)' },
];

// ---------- status ----------

function setStatus(message: string, isError = false): void {
  const node = $('status');
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message.match(/Error: (.*)$/s);
    return (m ? m[1] : e.message).trim();
  }
  return String(e);
}

// ---------- script list ----------

let dragSourceIndex: number | null = null;

function renderScriptList(): void {
  const list = $('script-list');
  list.textContent = '';

  state.utterances.forEach((u, i) => {
    const li = el('li');
    li.draggable = true;
    li.dataset.index = String(i);

    const row = el('div', 'sui-menu-item script-row');
    if (i === state.selected) row.classList.add('sui-active');

    row.appendChild(el('span', 'num', String(i + 1)));

    const text = el('span', 'line-text', u.text || '（空の行）');
    if (!u.text) text.classList.add('empty');
    row.appendChild(text);

    if (u.features.length === 0 && u.text) {
      const warn = el('span', 'unanalyzed', '未解析');
      warn.title = '再生するには解析が必要です';
      row.appendChild(warn);
    }

    const del = el('button', 'del', '✕');
    del.title = 'この行を削除';
    del.setAttribute('aria-label', 'この行を削除');
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeUtterance(i);
    });
    row.appendChild(del);

    row.addEventListener('click', () => selectUtterance(i));
    li.appendChild(row);

    // --- drag to reorder ---
    li.addEventListener('dragstart', (ev) => {
      dragSourceIndex = i;
      li.classList.add('dragging');
      ev.dataTransfer?.setData('text/plain', String(i));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      dragSourceIndex = null;
      li.classList.remove('dragging');
      list.querySelectorAll('.drop-before, .drop-after')
        .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    });
    li.addEventListener('dragover', (ev) => {
      if (dragSourceIndex === null) return; // a file drag, not a reorder
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = li.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (ev) => {
      if (dragSourceIndex === null) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = li.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      moveUtterance(dragSourceIndex, after ? i + 1 : i);
    });

    list.appendChild(li);
  });
}

function moveUtterance(from: number, to: number): void {
  if (from === to || from + 1 === to) return;
  pushHistory('move-line');
  const [item] = state.utterances.splice(from, 1);
  const target = to > from ? to - 1 : to;
  state.utterances.splice(target, 0, item);
  state.selected = target;
  renderScriptList();
  syncTextInput();
  setStatus(`${from + 1} 行目を ${target + 1} 行目へ移動しました`);
}

function newUtterance(text = ''): Utterance {
  return {
    id: makeId(),
    text,
    njd: [],
    phrases: [],
    features: [],
    params: { ...DEFAULT_PARAMS },
    voice: state.voice,
  };
}

function addUtterance(text = '', recordHistory = true): void {
  if (recordHistory) pushHistory('add-line');
  state.utterances.push(newUtterance(text));
  selectUtterance(state.utterances.length - 1);
}

function duplicateUtterance(): void {
  const u = current();
  if (!u) return;
  pushHistory('duplicate-line');
  const copy = structuredClone(u);
  copy.id = makeId();
  state.utterances.splice(state.selected + 1, 0, copy);
  selectUtterance(state.selected + 1);
  setStatus('行を複製しました');
}

function removeUtterance(index: number): void {
  if (index < 0 || index >= state.utterances.length) return;
  pushHistory('delete-line');
  state.utterances.splice(index, 1);
  if (state.utterances.length === 0) {
    state.utterances.push(newUtterance());
    selectUtterance(0);
    return;
  }
  selectUtterance(Math.min(index, state.utterances.length - 1));
  setStatus('行を削除しました');
}

function syncTextInput(): void {
  ($('text-input') as HTMLTextAreaElement).value = current()?.text ?? '';
}

function selectUtterance(index: number): void {
  state.selected = index;
  state.editingWord = null;
  syncTextInput();
  renderScriptList();
  renderParams();
  renderAccent();
  updateButtons();
}

// ---------- analysis & rebuild ----------

async function analyzeCurrent(): Promise<void> {
  const u = current();
  if (!u) return;
  const text = ($('text-input') as HTMLTextAreaElement).value.trim();

  if (u.text !== text || u.features.length === 0) pushHistory('analyze');
  u.text = text;
  renderScriptList();

  if (!text) {
    u.njd = [];
    u.phrases = [];
    u.features = [];
    renderAccent();
    updateButtons();
    return;
  }

  state.busy = true;
  updateButtons();
  setStatus('解析中…');
  try {
    const res = await api.analyze(text, config());
    u.njd = res.njd;
    u.phrases = res.phrases;
    u.features = res.features;
    renderAccent();
    renderScriptList();
    setStatus(`${res.phrases.length} アクセント句 / ${res.features.length} ラベル`);
  } catch (e) {
    setStatus(errorMessage(e), true);
    u.njd = [];
    u.phrases = [];
    u.features = [];
    renderAccent();
  } finally {
    state.busy = false;
    updateButtons();
  }
}

/** Re-derive phrases and labels after an accent edit. Pure, so it is cheap. */
async function applyEdit(njd: NjdNode[], label: string): Promise<void> {
  const u = current();
  if (!u) return;
  pushHistory(label);
  u.njd = njd;
  state.editingWord = null;
  try {
    const res = await api.rebuild(njd);
    u.phrases = res.phrases;
    u.features = res.features;
    renderAccent();
    updateButtons();
  } catch (e) {
    setStatus(errorMessage(e), true);
  }
}

// ---------- accent editor ----------

function renderAccent(): void {
  const area = $('accent-area');
  area.textContent = '';

  const u = current();
  if (!u || u.phrases.length === 0) {
    const empty = el('div', 'empty-state');
    empty.appendChild(el('p', 'empty-title', u?.text ? 'まだ解析していません' : 'テキストを入力してください'));
    empty.appendChild(el('p', 'sui-helper-text',
      u?.text ? '「解析」または ⌘R でアクセントを表示します。' : '上のテキスト欄に入力して Enter を押してください。'));
    area.appendChild(empty);
    return;
  }

  const flow = el('div', 'phrase-flow');

  u.phrases.forEach((phrase, pi) => {
    // Boundary controls live between every pair of adjacent accent phrases, so a
    // pause can always be put back after it is removed.
    if (pi > 0) flow.appendChild(makeBoundary(u, phrase));
    flow.appendChild(makePhrase(u, phrase));
  });

  area.appendChild(flow);
}

/** The control between two accent phrases: merge them, or toggle a pause. */
function makeBoundary(u: Utterance, phrase: AccentPhrase): HTMLElement {
  const paused = hasPauseBefore(u.njd, phrase);
  const wrap = el('div', 'boundary');
  if (paused) wrap.classList.add('paused');

  const merge = el('button', 'boundary-btn merge');
  merge.textContent = '結合';
  merge.disabled = paused;
  merge.title = paused
    ? 'ポーズを削除すると結合できます'
    : '前のアクセント句と結合';
  merge.addEventListener('click', () => {
    void applyEdit(mergeWithPrevious(u.njd, phrase), 'merge');
    setStatus('アクセント句を結合しました');
  });

  const pause = el('button', 'boundary-btn pause');
  pause.textContent = paused ? 'ポーズ削除' : 'ポーズ';
  pause.title = paused ? 'ここのポーズを削除' : 'ここにポーズを挿入';
  pause.addEventListener('click', () => {
    const next = paused ? removePauseBefore(u.njd, phrase) : insertPauseBefore(u.njd, phrase);
    void applyEdit(next, 'pause');
    setStatus(paused ? 'ポーズを削除しました' : 'ポーズを挿入しました');
  });

  const divider = el('div', 'boundary-divider');
  if (paused) divider.appendChild(el('span', 'pause-mark', 'ポーズ'));

  wrap.append(divider, el('div', 'boundary-actions'));
  wrap.lastElementChild!.append(merge, pause);
  return wrap;
}

function makePhrase(u: Utterance, phrase: AccentPhrase): HTMLElement {
  const wrap = el('div', 'phrase');

  const head = el('div', 'phrase-head');
  const badge = el('span', 'sui-chip', phrase.accent === 0 ? '平板' : `${phrase.accent}型`);
  if (phrase.accent === 0) badge.classList.add('heiban');
  badge.title = 'アクセント型（0 = 平板）';
  head.appendChild(badge);
  if (phrase.isQuestion) {
    const q = el('span', 'q', '？');
    q.title = '疑問イントネーション';
    head.appendChild(q);
  }
  wrap.appendChild(head);

  const pattern = pitchPattern(phrase.accent, phrase.moraCount);
  wrap.appendChild(makeContour(pattern));

  const row = el('div', 'moras');
  let moraIndex = 0;

  phrase.words.forEach((word, wi) => {
    // Inline reading editor replaces the word's moras while active.
    if (state.editingWord === word.njdIndex) {
      row.appendChild(makeReadingEditor(u, word.njdIndex));
      moraIndex += word.moraCount;
      return;
    }

    for (let k = 0; k < word.moraCount; k++, moraIndex++) {
      const mora = phrase.moras[moraIndex];
      if (!mora) continue;

      if (moraIndex > 0) {
        const gap = el('button', 'gap');
        if (k === 0) gap.classList.add('word'); // morpheme boundary, shown as a hint
        gap.title = 'ここでアクセント句を分割';
        gap.setAttribute('aria-label', 'ここでアクセント句を分割');
        const at = moraIndex;
        gap.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void applyEdit(splitAt(u.njd, phrase, at), 'split');
          setStatus('アクセント句を分割しました');
        });
        row.appendChild(gap);
      }

      const chip = el('button', 'mora');
      chip.classList.add(pattern[moraIndex] ? 'high' : 'low');
      if (phrase.accent > 0 && moraIndex === phrase.accent - 1) chip.classList.add('nucleus');
      chip.appendChild(el('span', 'kana', mora.text));
      chip.appendChild(el('span', 'ph', mora.phonemes.join(' ')));
      chip.title = `${moraIndex + 1} モーラ目 — クリックでアクセント核（ダブルクリックで読みを編集）`;

      const at = moraIndex;
      chip.addEventListener('click', () => {
        void applyEdit(setAccent(u.njd, phrase, phrase.accent === at + 1 ? 0 : at + 1), 'accent');
      });
      chip.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        state.editingWord = word.njdIndex;
        renderAccent();
      });
      row.appendChild(chip);
    }
    void wi;
  });

  wrap.appendChild(row);
  return wrap;
}

/** Inline katakana editor for one morpheme's reading. */
function makeReadingEditor(u: Utterance, njdIndex: number): HTMLElement {
  const box = el('div', 'reading-editor');
  const input = el('input', 'sui-input reading-input');
  input.type = 'text';
  input.value = u.njd[njdIndex]?.pron ?? '';
  input.title = 'カタカナで読みを入力（ー と ’ が使えます）';
  input.setAttribute('aria-label', '読みを編集');

  const commit = (): void => {
    const value = input.value.trim();
    if (value && value !== u.njd[njdIndex]?.pron) {
      void applyEdit(setPron(u.njd, njdIndex, value), 'pron');
      setStatus('読みを変更しました');
    } else {
      state.editingWord = null;
      renderAccent();
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); state.editingWord = null; renderAccent(); }
  });
  input.addEventListener('blur', commit);

  box.appendChild(input);
  // Focus after the element lands in the document.
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return box;
}

/** Draw the high/low pitch line above a phrase's moras. */
function makeContour(pattern: boolean[]): HTMLElement {
  const box = el('div', 'contour');
  const n = pattern.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.max(n, 1) * 10} 10`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const yFor = (high: boolean): number => (high ? 2.5 : 7.5);
  const points: string[] = [];
  pattern.forEach((high, i) => {
    const x0 = i * 10;
    points.push(`${x0},${yFor(high)}`, `${x0 + 10},${yFor(high)}`);
  });

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  pattern.forEach((high, i) => {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(i * 10 + 5));
    dot.setAttribute('cy', String(yFor(high)));
    dot.setAttribute('r', '1.6');
    dot.setAttribute('fill', 'currentColor');
    dot.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(dot);
  });

  box.appendChild(svg);
  return box;
}

// ---------- parameters ----------

function renderParams(): void {
  const host = $('params');
  host.textContent = '';
  const u = current();
  if (!u) return;

  for (const def of PARAM_DEFS) {
    const raw = u.params[def.key] ?? DEFAULT_PARAMS[def.key] ?? 0;
    const row = el('div', 'param');

    const head = el('div', 'param-head');
    const label = el('label', 'sui-label', def.label);
    label.htmlFor = `param-${def.key}`;
    const value = el('span', 'value', def.format ? def.format(raw) : raw.toFixed(2));
    head.append(label, value);

    const slider = el('input');
    slider.type = 'range';
    slider.id = `param-${def.key}`;
    slider.min = String(def.min);
    slider.max = String(def.max);
    slider.step = String(def.step);
    slider.value = String(raw);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      // One undo step per gesture rather than per pixel of travel.
      pushHistory(`param:${def.key}`, 700);
      u.params[def.key] = v;
      value.textContent = def.format ? def.format(v) : v.toFixed(2);
    });

    const desc = el('p', 'sui-helper-text', def.desc);
    row.append(head, slider, desc);
    host.appendChild(row);
  }
}

// ---------- playback ----------

let audio: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
/** Bumped on every stop so an in-flight "play all" loop knows to abandon. */
let playToken = 0;

function releaseAudio(): void {
  if (audio) { audio.pause(); audio = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
}

function playBuffer(wav: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    releaseAudio();
    audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    audio = new Audio(audioUrl);
    audio.addEventListener('ended', () => resolve());
    audio.addEventListener('error', () => reject(new Error('再生できませんでした')));
    void audio.play().catch(reject);
  });
}

async function play(): Promise<void> {
  const u = current();
  if (!u || u.features.length === 0) return;
  const token = ++playToken;
  state.busy = true;
  state.playing = true;
  updateButtons();
  setStatus('合成中…');
  try {
    const wav = await api.synthesize(u.features, config(), u.params);
    if (token !== playToken) return;
    state.busy = false;
    updateButtons();
    setStatus('再生中…');
    await playBuffer(wav);
    if (token === playToken) setStatus('再生完了');
  } catch (e) {
    setStatus(errorMessage(e), true);
  } finally {
    if (token === playToken) {
      state.playing = false;
      state.busy = false;
      updateButtons();
    }
  }
}

async function playAll(): Promise<void> {
  const lines = state.utterances.filter((u) => u.features.length > 0);
  if (lines.length === 0) { setStatus('解析済みの行がありません', true); return; }

  const token = ++playToken;
  state.playing = true;
  updateButtons();
  try {
    for (let i = 0; i < lines.length; i++) {
      if (token !== playToken) return;
      const u = lines[i];
      setStatus(`再生中… (${i + 1}/${lines.length})`);
      const wav = await api.synthesize(u.features, { voice: u.voice ?? state.voice }, u.params);
      if (token !== playToken) return;
      await playBuffer(wav);
    }
    if (token === playToken) setStatus('すべて再生しました');
  } catch (e) {
    setStatus(errorMessage(e), true);
  } finally {
    if (token === playToken) {
      state.playing = false;
      updateButtons();
    }
  }
}

function stop(): void {
  playToken++;
  releaseAudio();
  state.playing = false;
  state.busy = false;
  updateButtons();
  setStatus('停止しました');
}

// ---------- export ----------

const safeName = (text: string): string =>
  (text || 'output').slice(0, 24).replace(/[/\\:*?"<>|\s]/g, '_');

async function exportWav(): Promise<void> {
  const u = current();
  if (!u || u.features.length === 0) return;
  setStatus('書き出し中…');
  try {
    const wav = await api.synthesize(u.features, config(), u.params);
    const saved = await api.saveWav(wav, `${safeName(u.text)}.wav`);
    setStatus(saved ? `保存しました: ${saved}` : 'キャンセルしました');
  } catch (e) {
    setStatus(errorMessage(e), true);
  }
}

async function exportWavAll(): Promise<void> {
  const lines = state.utterances.filter((u) => u.features.length > 0);
  if (lines.length === 0) { setStatus('解析済みの行がありません', true); return; }
  state.busy = true;
  updateButtons();
  try {
    const items: { name: string; data: ArrayBuffer }[] = [];
    for (let i = 0; i < lines.length; i++) {
      setStatus(`合成中… (${i + 1}/${lines.length})`);
      const u = lines[i];
      const wav = await api.synthesize(u.features, { voice: u.voice ?? state.voice }, u.params);
      items.push({ name: `${String(i + 1).padStart(3, '0')}_${safeName(u.text)}.wav`, data: wav });
    }
    const res = await api.saveWavBatch(items);
    setStatus(res ? `${res.count} 件を ${res.dir} に保存しました` : 'キャンセルしました');
  } catch (e) {
    setStatus(errorMessage(e), true);
  } finally {
    state.busy = false;
    updateButtons();
  }
}

async function exportLabels(): Promise<void> {
  const u = current();
  if (!u || u.features.length === 0) return;
  const saved = await api.saveText(u.features.join('\n') + '\n', `${safeName(u.text)}.lab`,
    [{ name: 'HTS full-context label', extensions: ['lab'] }]);
  setStatus(saved ? `保存しました: ${saved}` : 'キャンセルしました');
}

// ---------- project files ----------

function serialize(): string {
  const u = current();
  if (u) u.text = ($('text-input') as HTMLTextAreaElement).value;
  return JSON.stringify({ version: 1, utterances: state.utterances }, null, 2);
}

async function saveProject(forceDialog = false): Promise<void> {
  const data = serialize();
  try {
    if (state.filePath && !forceDialog) {
      await api.writeText(state.filePath, data);
      markClean();
      setStatus(`保存しました: ${state.filePath}`);
      return;
    }
    const saved = await api.saveText(data, 'script.jtalk.json',
      [{ name: 'JTalk GUI project', extensions: ['json'] }]);
    if (saved) {
      state.filePath = saved;
      markClean();
      setStatus(`保存しました: ${saved}`);
    } else {
      setStatus('キャンセルしました');
    }
  } catch (e) {
    setStatus(errorMessage(e), true);
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return api.confirm('保存していない変更があります', '続行すると編集内容は失われます。');
}

function loadProjectData(text: string, filePath: string | null): void {
  const parsed = JSON.parse(text) as { utterances?: Utterance[] };
  if (!Array.isArray(parsed.utterances) || parsed.utterances.length === 0) {
    throw new Error('台本が空です');
  }
  state.utterances = parsed.utterances.map((u) => ({
    ...newUtterance(),
    ...u,
    id: makeId(),
    features: u.features ?? [],
    params: { ...DEFAULT_PARAMS, ...u.params },
  }));
  state.filePath = filePath;
  history.past.length = 0;
  history.future.length = 0;
  selectUtterance(0);
  markClean();
}

async function openProject(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const opened = await api.openText([{ name: 'JTalk GUI project', extensions: ['json'] }]);
  if (!opened) return;
  try {
    loadProjectData(opened.text, opened.path);
    setStatus(`読み込みました: ${opened.path}`);
  } catch (e) {
    setStatus(`読み込めませんでした: ${errorMessage(e)}`, true);
  }
}

// ---------- drag & drop of files ----------

function setDropOverlay(visible: boolean, message = ''): void {
  const overlay = $('drop-overlay');
  overlay.classList.toggle('visible', visible);
  if (message) $('drop-message').textContent = message;
}

async function handleDroppedFiles(files: File[]): Promise<void> {
  const project = files.find((f) => f.name.endsWith('.json'));
  const voices = files.filter((f) => f.name.endsWith('.htsvoice'));
  const texts = files.filter((f) => /\.(txt|md|csv)$/i.test(f.name));

  if (project) {
    if (!(await confirmDiscard())) return;
    try {
      loadProjectData(await project.text(), api.pathForFile(project));
      setStatus(`読み込みました: ${project.name}`);
    } catch (e) {
      setStatus(`読み込めませんでした: ${errorMessage(e)}`, true);
    }
    return;
  }

  if (voices.length > 0) {
    // Register the containing directory so every voice beside it is picked up too.
    const dir = api.pathForFile(voices[0]).replace(/[/\\][^/\\]+$/, '');
    const settings = state.paths?.settings;
    const dirs = new Set(settings?.extraVoiceDirs ?? []);
    dirs.add(dir);
    state.paths = await api.saveSettings({ ...settings, extraVoiceDirs: [...dirs] });
    const added = state.paths.voices.find((v) => v.path === api.pathForFile(voices[0]));
    fillVoiceSelect(state.paths.voices, added?.path ?? state.voice);
    showEngineInfo();
    setStatus(`音声モデルを追加しました: ${voices[0].name}`);
    return;
  }

  if (texts.length > 0) {
    const lines: string[] = [];
    for (const f of texts) {
      lines.push(...(await f.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    }
    if (lines.length === 0) { setStatus('読み込める行がありませんでした', true); return; }
    pushHistory('import-text');
    // Replace a single untouched empty line rather than appending after it.
    if (state.utterances.length === 1 && !state.utterances[0].text) state.utterances.length = 0;
    for (const line of lines) state.utterances.push(newUtterance(line));
    selectUtterance(state.utterances.length - lines.length);
    setStatus(`${lines.length} 行を読み込みました。⌘R で解析できます。`);
    return;
  }

  setStatus('対応していないファイルです（.json / .txt / .htsvoice）', true);
}

function wireFileDrop(): void {
  let depth = 0;

  const isFileDrag = (ev: DragEvent): boolean =>
    !!ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files');

  window.addEventListener('dragenter', (ev) => {
    if (!isFileDrag(ev) || dragSourceIndex !== null) return;
    ev.preventDefault();
    depth++;
    setDropOverlay(true, '台本 (.json) / テキスト (.txt) / 音声モデル (.htsvoice) をドロップ');
  });
  window.addEventListener('dragover', (ev) => {
    if (!isFileDrag(ev) || dragSourceIndex !== null) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDropOverlay(false);
  });
  window.addEventListener('drop', (ev) => {
    depth = 0;
    setDropOverlay(false);
    if (!isFileDrag(ev) || dragSourceIndex !== null) return;
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (files.length > 0) void handleDroppedFiles(files);
  });
}

// ---------- settings ----------

function fillVoiceSelect(voices: VoiceInfo[], selected: string | null): void {
  const sel = $('voice-select') as HTMLSelectElement;
  sel.textContent = '';
  if (voices.length === 0) {
    const opt = el('option', undefined, '（音声モデルが見つかりません）');
    opt.value = '';
    sel.appendChild(opt);
    return;
  }
  for (const v of voices) {
    const opt = el('option', undefined, v.name);
    opt.value = v.path;
    sel.appendChild(opt);
  }
  // Alphabetical order would land on "mei_angry"; prefer a neutral voice instead.
  const neutral = voices.find((v) => /normal|neutral/i.test(v.name)) ?? voices[0];
  sel.value = selected && voices.some((v) => v.path === selected) ? selected : neutral.path;
  state.voice = sel.value;
}

function openSettings(): void {
  const s = state.paths?.settings;
  ($('set-openjtalk') as HTMLInputElement).value = s?.openJtalk ?? '';
  ($('set-htsengine') as HTMLInputElement).value = s?.htsEngine ?? '';
  ($('set-dictionary') as HTMLInputElement).value = s?.dictionary ?? '';
  ($('set-voicedir') as HTMLInputElement).value = s?.extraVoiceDirs?.[0] ?? '';
  ($('settings-dialog') as HTMLDialogElement).showModal();
}

async function commitSettings(): Promise<void> {
  const voiceDir = ($('set-voicedir') as HTMLInputElement).value.trim();
  state.paths = await api.saveSettings({
    openJtalk: ($('set-openjtalk') as HTMLInputElement).value.trim() || null,
    htsEngine: ($('set-htsengine') as HTMLInputElement).value.trim() || null,
    dictionary: ($('set-dictionary') as HTMLInputElement).value.trim() || null,
    voice: state.voice,
    extraVoiceDirs: voiceDir ? [voiceDir] : [],
  });
  fillVoiceSelect(state.paths.voices, state.voice);
  showEngineInfo();
  setStatus('設定を保存しました');
}

function showEngineInfo(): void {
  const p = state.paths;
  if (!p) return;
  const missing: string[] = [];
  if (!p.openJtalk) missing.push('open_jtalk');
  if (!p.htsEngine) missing.push('hts_engine');
  if (!p.dictionary) missing.push('辞書');
  if (p.voices.length === 0) missing.push('htsvoice');

  const info = $('engine-info');
  if (missing.length > 0) {
    info.textContent = `未検出: ${missing.join(' / ')} — 設定から指定してください`;
    info.classList.add('error');
  } else {
    info.textContent = `open_jtalk + hts_engine / 音声 ${p.voices.length} 件`;
    info.classList.remove('error');
  }
}

// ---------- buttons ----------

function updateButtons(): void {
  const u = current();
  const ready = !!u && u.features.length > 0 && !state.busy;
  const anyReady = state.utterances.some((x) => x.features.length > 0);

  ($('btn-play') as HTMLButtonElement).disabled = !ready || state.playing;
  ($('btn-play-all') as HTMLButtonElement).disabled = !anyReady || state.playing || state.busy;
  ($('btn-stop') as HTMLButtonElement).disabled = !state.playing;
  ($('btn-export-wav') as HTMLButtonElement).disabled = !ready;
  ($('btn-export-lab') as HTMLButtonElement).disabled = !ready;
  ($('btn-analyze') as HTMLButtonElement).disabled = state.busy;
}

// ---------- menu & shortcuts ----------

function handleMenuAction(action: MenuAction): void {
  switch (action) {
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'new-line': addUtterance(); break;
    case 'duplicate-line': duplicateUtterance(); break;
    case 'delete-line': removeUtterance(state.selected); break;
    case 'move-line-up': moveUtterance(state.selected, state.selected - 1); break;
    case 'move-line-down': moveUtterance(state.selected, state.selected + 2); break;
    case 'open': void openProject(); break;
    case 'save': void saveProject(false); break;
    case 'save-as': void saveProject(true); break;
    case 'analyze': void analyzeCurrent(); break;
    case 'play': state.playing ? stop() : void play(); break;
    case 'play-all': void playAll(); break;
    case 'stop': stop(); break;
    case 'export-wav': void exportWav(); break;
    case 'export-wav-all': void exportWavAll(); break;
    case 'export-labels': void exportLabels(); break;
    case 'settings': openSettings(); break;
  }
}

// ---------- wiring ----------

function wire(): void {
  $('btn-analyze').addEventListener('click', () => void analyzeCurrent());
  $('btn-play').addEventListener('click', () => void play());
  $('btn-play-all').addEventListener('click', () => void playAll());
  $('btn-stop').addEventListener('click', stop);
  $('btn-export-wav').addEventListener('click', () => void exportWav());
  $('btn-export-lab').addEventListener('click', () => void exportLabels());
  $('btn-save').addEventListener('click', () => void saveProject(false));
  $('btn-open').addEventListener('click', () => void openProject());
  $('btn-add-line').addEventListener('click', () => addUtterance());
  $('btn-settings').addEventListener('click', openSettings);

  $('btn-reset-params').addEventListener('click', () => {
    const u = current();
    if (!u) return;
    pushHistory('reset-params');
    u.params = { ...DEFAULT_PARAMS };
    renderParams();
    setStatus('パラメータを既定値に戻しました');
  });

  const textInput = $('text-input') as HTMLTextAreaElement;
  textInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void analyzeCurrent();
    }
  });
  textInput.addEventListener('input', () => {
    const u = current();
    if (!u) return;
    pushHistory('type', 800);
    u.text = textInput.value;
    renderScriptList();
  });

  ($('voice-select') as HTMLSelectElement).addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
    pushHistory('voice');
    state.voice = value;
    const u = current();
    if (u) u.voice = value;
    setStatus('音声モデルを変更しました');
  });

  $('settings-save').addEventListener('click', () => void commitSettings());

  document.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.kind === 'directory' ? 'directory' : 'file';
      const picked = await api.pickPath(kind);
      if (picked) ($(btn.dataset.pick!) as HTMLInputElement).value = picked;
    });
  });

  api.onMenuAction(handleMenuAction);
  api.onAccentColor(applyAccentColor);
  // Same entry point the native menu uses, reachable from the UI test driver.
  window.addEventListener('__menu', (ev) => handleMenuAction((ev as CustomEvent).detail as MenuAction));
  wireFileDrop();

  // Shortcuts that are not worth a menu entry.
  window.addEventListener('keydown', (ev) => {
    const inField = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;

    if (ev.key === 'Escape' && state.playing) { stop(); return; }

    if (!inField && ev.key === ' ') {
      ev.preventDefault();
      state.playing ? stop() : void play();
      return;
    }
    if (!inField && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      const next = state.selected + (ev.key === 'ArrowDown' ? 1 : -1);
      if (next >= 0 && next < state.utterances.length) selectUtterance(next);
    }
  });

  window.addEventListener('beforeunload', releaseAudio);
}

async function init(): Promise<void> {
  document.body.dataset.platform = api.platform;
  wire();
  updateTitle();

  try {
    state.paths = await api.detect();
    applyAccentColor(state.paths.accentColor);
    fillVoiceSelect(state.paths.voices, state.paths.settings.voice);
    showEngineInfo();
    setStatus(state.paths.voices.length > 0 ? 'テキストを入力してください' : '音声モデルが見つかりません');
  } catch (e) {
    setStatus(errorMessage(e), true);
  }

  state.utterances.push(newUtterance('こんにちは。アクセントを編集できます。'));
  selectUtterance(0);
  renderParams();
  if (state.paths && state.paths.voices.length > 0) await analyzeCurrent();

  // The seeded line is not a user edit.
  history.past.length = 0;
  history.future.length = 0;
  markClean();
}

void init();
