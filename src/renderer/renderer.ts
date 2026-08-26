// Renderer: script list, accent editor, parameter panel, playback.
// All engine work happens in the main process; this talks to it through window.api.

import type {
  AccentPhrase, EngineConfig, EnginePaths, NjdNode, SynthParams, Utterance, VoiceInfo,
} from '../shared/types';
import { DEFAULT_PARAMS } from '../shared/types';
import {
  setAccent, mergeWithPrevious, splitAt, insertPauseBefore, removePauseBefore, hasPauseBefore, pitchPattern,
} from '../main/engine/edit';

interface Settings {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voice: string | null;
  extraVoiceDirs: string[];
}

interface DetectResult extends EnginePaths { settings: Settings }

interface Api {
  detect(): Promise<DetectResult>;
  saveSettings(s: Settings): Promise<DetectResult>;
  analyze(text: string, cfg: Partial<EngineConfig>): Promise<{ njd: NjdNode[]; phrases: AccentPhrase[]; features: string[] }>;
  rebuild(njd: NjdNode[]): Promise<{ phrases: AccentPhrase[]; features: string[] }>;
  synthesize(features: string[], cfg: Partial<EngineConfig>, params: SynthParams): Promise<ArrayBuffer>;
  saveWav(data: ArrayBuffer, defaultName: string): Promise<string | null>;
  saveText(text: string, defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  openText(filters: { name: string; extensions: string[] }[]): Promise<{ path: string; text: string } | null>;
  pickPath(kind: 'file' | 'directory'): Promise<string | null>;
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
  features: string[];
  paths: DetectResult | null;
  voice: string | null;
  playing: boolean;
  busy: boolean;
}

const state: State = {
  utterances: [],
  selected: -1,
  features: [],
  paths: null,
  voice: null,
  playing: false,
  busy: false,
};

let nextId = 1;
const makeId = (): string => `u${nextId++}`;

const current = (): Utterance | null => state.utterances[state.selected] ?? null;

function config(): Partial<EngineConfig> {
  const u = current();
  return { voice: u?.voice ?? state.voice };
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
    // Electron wraps main-process errors; keep only the useful tail.
    const m = e.message.match(/Error: (.*)$/s);
    return (m ? m[1] : e.message).trim();
  }
  return String(e);
}

// ---------- script list ----------

function renderScriptList(): void {
  const list = $('script-list');
  list.textContent = '';

  state.utterances.forEach((u, i) => {
    const li = el('li');
    const row = el('div', 'sui-menu-item script-row');
    if (i === state.selected) row.classList.add('sui-active');

    row.appendChild(el('span', 'num', String(i + 1)));

    const text = el('span', 'line-text', u.text || '（空の行）');
    if (!u.text) text.classList.add('empty');
    row.appendChild(text);

    const del = el('button', 'del', '✕');
    del.title = 'この行を削除';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeUtterance(i);
    });
    row.appendChild(del);

    row.addEventListener('click', () => selectUtterance(i));
    li.appendChild(row);
    list.appendChild(li);
  });
}

function addUtterance(text = ''): void {
  state.utterances.push({
    id: makeId(),
    text,
    njd: [],
    phrases: [],
    params: { ...DEFAULT_PARAMS },
    voice: state.voice,
  });
  selectUtterance(state.utterances.length - 1);
}

function removeUtterance(index: number): void {
  state.utterances.splice(index, 1);
  if (state.utterances.length === 0) {
    state.selected = -1;
    addUtterance();
    return;
  }
  selectUtterance(Math.min(index, state.utterances.length - 1));
}

function selectUtterance(index: number): void {
  state.selected = index;
  const u = current();
  ($('text-input') as HTMLTextAreaElement).value = u?.text ?? '';
  state.features = [];
  renderScriptList();
  renderParams();
  if (u && u.njd.length > 0) {
    void rebuild(u.njd);
  } else {
    renderAccent();
    updateButtons();
  }
}

// ---------- analysis & rebuild ----------

async function analyzeCurrent(): Promise<void> {
  const u = current();
  if (!u) return;
  const text = ($('text-input') as HTMLTextAreaElement).value.trim();
  u.text = text;
  renderScriptList();

  if (!text) {
    u.njd = [];
    u.phrases = [];
    state.features = [];
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
    state.features = res.features;
    renderAccent();
    setStatus(`${res.phrases.length} アクセント句 / ${res.features.length} ラベル`);
  } catch (e) {
    setStatus(errorMessage(e), true);
    u.njd = [];
    u.phrases = [];
    state.features = [];
    renderAccent();
  } finally {
    state.busy = false;
    updateButtons();
  }
}

/** Re-derive phrases and labels after an edit. Pure, so it is cheap. */
async function rebuild(njd: NjdNode[]): Promise<void> {
  const u = current();
  if (!u) return;
  u.njd = njd;
  try {
    const res = await api.rebuild(njd);
    u.phrases = res.phrases;
    state.features = res.features;
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
    area.appendChild(el('p', 'placeholder', 'テキストを解析するとアクセント句がここに表示されます。'));
    return;
  }

  // Group the phrases into their breath groups, each rendered as a card.
  let group: HTMLElement | null = null;
  let groupIndex = -1;

  u.phrases.forEach((phrase, pi) => {
    if (phrase.breathGroup !== groupIndex) {
      groupIndex = phrase.breathGroup;
      group = el('div', 'sui-card breath-group');
      group.appendChild(el('div', 'bg-label', `ブレスグループ ${groupIndex + 1}`));
      area.appendChild(group);
    }

    // Between two phrases in the same group: a gap that merges them, plus a
    // control for the pause that separates breath groups.
    if (pi > 0 && u.phrases[pi - 1].breathGroup === phrase.breathGroup) {
      group!.appendChild(makeBoundaryGap(phrase));
    }
    group!.appendChild(makePhrase(phrase, pi));
  });

  // Pause controls sit between breath groups.
  renderPauseControls(area, u);
}

function renderPauseControls(area: HTMLElement, u: Utterance): void {
  const cards = area.querySelectorAll('.breath-group');
  cards.forEach((card, i) => {
    if (i === 0) return;
    const firstPhrase = u.phrases.find((p) => p.breathGroup === i);
    if (!firstPhrase) return;

    const chip = el('button', 'sui-chip pause-chip', hasPauseBefore(u.njd, firstPhrase) ? 'ポーズあり ✕' : 'ポーズ追加');
    chip.title = hasPauseBefore(u.njd, firstPhrase) ? 'このポーズを削除' : 'ここにポーズを挿入';
    chip.addEventListener('click', () => {
      const next = hasPauseBefore(u.njd, firstPhrase)
        ? removePauseBefore(u.njd, firstPhrase)
        : insertPauseBefore(u.njd, firstPhrase);
      void rebuild(next);
    });

    const holder = el('div', 'pause-holder');
    holder.style.display = 'flex';
    holder.style.justifyContent = 'center';
    holder.style.margin = '-6px 0 6px';
    holder.appendChild(chip);
    card.parentNode?.insertBefore(holder, card);
  });
}

/** The gap between two accent phrases; clicking it merges the right into the left. */
function makeBoundaryGap(phrase: AccentPhrase): HTMLElement {
  const gap = el('button', 'gap boundary');
  gap.title = '前のアクセント句と結合';
  gap.addEventListener('click', () => {
    const u = current();
    if (!u) return;
    void rebuild(mergeWithPrevious(u.njd, phrase));
  });
  return gap;
}

function makePhrase(phrase: AccentPhrase, phraseIndex: number): HTMLElement {
  const wrap = el('div', 'phrase');

  // header: accent type badge
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

  // moras, with a clickable gap at every internal mora boundary
  const moras = el('div', 'moras');
  const wordStarts = new Set<number>();
  {
    let acc = 0;
    for (const w of phrase.words) { wordStarts.add(acc); acc += w.moraCount; }
  }

  phrase.moras.forEach((mora, mi) => {
    if (mi > 0) {
      const gap = el('button', 'gap');
      if (wordStarts.has(mi)) gap.classList.add('word');
      gap.title = 'ここで分割';
      gap.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const u = current();
        if (!u) return;
        void rebuild(splitAt(u.njd, phrase, mi));
      });
      moras.appendChild(gap);
    }

    const chip = el('button', 'mora');
    chip.classList.add(pattern[mi] ? 'high' : 'low');
    // The nucleus is the last high mora before the fall.
    if (phrase.accent > 0 && mi === phrase.accent - 1) chip.classList.add('nucleus');
    chip.appendChild(el('span', 'kana', mora.text));
    chip.appendChild(el('span', 'ph', mora.phonemes.join(' ')));
    chip.title = `${mi + 1} モーラ目 — クリックでアクセント核に設定（再クリックで平板）`;
    chip.addEventListener('click', () => {
      const u = current();
      if (!u) return;
      // Clicking the current nucleus clears it back to heiban.
      const next = phrase.accent === mi + 1 ? 0 : mi + 1;
      void rebuild(setAccent(u.njd, phrase, next));
    });
    moras.appendChild(chip);
  });

  wrap.appendChild(moras);
  wrap.addEventListener('click', () => {
    document.querySelectorAll('.phrase.selected').forEach((n) => n.classList.remove('selected'));
    wrap.classList.add('selected');
  });
  void phraseIndex;
  return wrap;
}

/** Draw the high/low pitch line above a phrase's moras. */
function makeContour(pattern: boolean[]): HTMLElement {
  const box = el('div', 'contour');
  const n = pattern.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.max(n, 1) * 10} 10`);
  svg.setAttribute('preserveAspectRatio', 'none');

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

  // a dot at the centre of each mora
  pattern.forEach((high, i) => {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(i * 10 + 5));
    dot.setAttribute('cy', String(yFor(high)));
    dot.setAttribute('r', '1.6');
    dot.setAttribute('fill', 'currentColor');
    dot.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(dot);
  });

  box.style.color = 'var(--app-pitch-high)';
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

function releaseAudio(): void {
  if (audio) { audio.pause(); audio = null; }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
}

async function play(): Promise<void> {
  const u = current();
  if (!u || state.features.length === 0) return;
  state.busy = true;
  updateButtons();
  setStatus('合成中…');
  try {
    const wav = await api.synthesize(state.features, config(), u.params);
    releaseAudio();
    audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    audio = new Audio(audioUrl);
    audio.addEventListener('ended', () => { state.playing = false; updateButtons(); setStatus('再生完了'); });
    state.playing = true;
    await audio.play();
    setStatus('再生中…');
  } catch (e) {
    setStatus(errorMessage(e), true);
    state.playing = false;
  } finally {
    state.busy = false;
    updateButtons();
  }
}

function stop(): void {
  if (audio) { audio.pause(); audio.currentTime = 0; }
  state.playing = false;
  updateButtons();
  setStatus('停止');
}

// ---------- export & project files ----------

async function exportWav(): Promise<void> {
  const u = current();
  if (!u || state.features.length === 0) return;
  setStatus('書き出し中…');
  try {
    const wav = await api.synthesize(state.features, config(), u.params);
    const name = (u.text || 'output').slice(0, 24).replace(/[/\\:*?"<>|]/g, '_');
    const saved = await api.saveWav(wav, `${name}.wav`);
    setStatus(saved ? `保存しました: ${saved}` : 'キャンセルしました');
  } catch (e) {
    setStatus(errorMessage(e), true);
  }
}

async function exportLabels(): Promise<void> {
  const u = current();
  if (!u || state.features.length === 0) return;
  const name = (u.text || 'output').slice(0, 24).replace(/[/\\:*?"<>|]/g, '_');
  const saved = await api.saveText(state.features.join('\n') + '\n', `${name}.lab`,
    [{ name: 'HTS full-context label', extensions: ['lab'] }]);
  setStatus(saved ? `保存しました: ${saved}` : 'キャンセルしました');
}

async function saveProject(): Promise<void> {
  const u = current();
  if (u) u.text = ($('text-input') as HTMLTextAreaElement).value;
  const data = JSON.stringify({ version: 1, utterances: state.utterances }, null, 2);
  const saved = await api.saveText(data, 'script.jtalk.json',
    [{ name: 'JTalk GUI project', extensions: ['json'] }]);
  setStatus(saved ? `保存しました: ${saved}` : 'キャンセルしました');
}

async function openProject(): Promise<void> {
  const opened = await api.openText([{ name: 'JTalk GUI project', extensions: ['json'] }]);
  if (!opened) return;
  try {
    const parsed = JSON.parse(opened.text) as { utterances?: Utterance[] };
    if (!Array.isArray(parsed.utterances) || parsed.utterances.length === 0) {
      throw new Error('台本が空です');
    }
    state.utterances = parsed.utterances.map((u) => ({
      ...u,
      id: makeId(),
      params: { ...DEFAULT_PARAMS, ...u.params },
    }));
    selectUtterance(0);
    setStatus(`読み込みました: ${opened.path}`);
  } catch (e) {
    setStatus(`読み込めませんでした: ${errorMessage(e)}`, true);
  }
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
  const next: Settings = {
    openJtalk: ($('set-openjtalk') as HTMLInputElement).value.trim() || null,
    htsEngine: ($('set-htsengine') as HTMLInputElement).value.trim() || null,
    dictionary: ($('set-dictionary') as HTMLInputElement).value.trim() || null,
    voice: state.voice,
    extraVoiceDirs: voiceDir ? [voiceDir] : [],
  };
  state.paths = await api.saveSettings(next);
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
  const ready = state.features.length > 0 && !state.busy;
  ($('btn-play') as HTMLButtonElement).disabled = !ready || state.playing;
  ($('btn-stop') as HTMLButtonElement).disabled = !state.playing;
  ($('btn-export-wav') as HTMLButtonElement).disabled = !ready;
  ($('btn-export-lab') as HTMLButtonElement).disabled = !ready;
  ($('btn-analyze') as HTMLButtonElement).disabled = state.busy;
}

// ---------- wiring ----------

function wire(): void {
  $('btn-analyze').addEventListener('click', () => void analyzeCurrent());
  $('btn-play').addEventListener('click', () => void play());
  $('btn-stop').addEventListener('click', stop);
  $('btn-export-wav').addEventListener('click', () => void exportWav());
  $('btn-export-lab').addEventListener('click', () => void exportLabels());
  $('btn-save').addEventListener('click', () => void saveProject());
  $('btn-open').addEventListener('click', () => void openProject());
  $('btn-add-line').addEventListener('click', () => addUtterance());
  $('btn-settings').addEventListener('click', openSettings);

  $('btn-reset-params').addEventListener('click', () => {
    const u = current();
    if (!u) return;
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
    u.text = textInput.value;
    renderScriptList();
  });

  ($('voice-select') as HTMLSelectElement).addEventListener('change', (ev) => {
    const value = (ev.target as HTMLSelectElement).value;
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

  window.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' && ev.target === document.body) {
      ev.preventDefault();
      state.playing ? stop() : void play();
    }
  });

  window.addEventListener('beforeunload', releaseAudio);
}

async function init(): Promise<void> {
  wire();
  try {
    state.paths = await api.detect();
    fillVoiceSelect(state.paths.voices, state.paths.settings.voice);
    showEngineInfo();
    setStatus(state.paths.voices.length > 0 ? 'テキストを入力してください' : '音声モデルが見つかりません');
  } catch (e) {
    setStatus(errorMessage(e), true);
  }
  addUtterance('こんにちは。アクセントを編集できます。');
  renderParams();
  if (state.paths && state.paths.voices.length > 0) await analyzeCurrent();
}

void init();
