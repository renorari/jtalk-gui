// Port of Open JTalk 1.11 njd2jpcommon + jpcommon_label.
//
// Given the NJD morpheme list that open_jtalk's text analysis produced (optionally
// with user edits to pron / acc / chainFlag), this rebuilds the HTS full-context
// labels that hts_engine consumes. Structure and field order mirror the C so the two
// can be diffed line for line -- see test/validate-labels.ts.
//
// Field layout follows "An example of context-dependent label format for HMM-based
// speech synthesis in Japanese" (HTS Working Group, 2015-12-25); see lab_format.pdf.
// Note the spec names b2/b3 "inflected forms"/"conjugation type", but the C emits
// pos-ctype_cform in that order. We follow the C, since the shipped voices were
// trained against labels the C produced.

import { MORA_LIST, UNVOICE, JP_POS, JP_CFORM, JP_CTYPE, NJD_POS, NJD_CFORM, NJD_CTYPE } from './tables';
import type { NjdNode, AccentPhrase, LabelResult, Mora } from '../../shared/types';

export const MORA_UNVOICE = '’';
export const MORA_LONG_VOWEL = 'ー';
export const MORA_SHORT_PAUSE = '、';
export const MORA_QUESTION = '？';

const PH_SHORT_PAUSE = 'pau';
const PH_SILENT = 'sil';
const PH_UNKNOWN = 'xx';
const FLAG_QUESTION = '1';

const MAX_S = 19, MAX_M = 49, MAX_L = 99, MAX_LL = 199;

const limit = (v: number, min: number, max: number): number => (v <= min ? min : v >= max ? max : v);

// --- njd2jpcommon ---------------------------------------------------------

function convertPos(pos: string, g1: string, g2: string, g3: string): string {
  for (const row of NJD_POS) {
    if (row[0] === pos && row[1] === g1 && row[2] === g2 && row[3] === g3) return row[4];
  }
  return NJD_POS[0][4]; // the C falls back to njd2jpcommon_pos_list[4] == "その他"
}
const convertCtype = (c: string): string => NJD_CTYPE[c] ?? NJD_CTYPE['*'];
const convertCform = (c: string): string => NJD_CFORM[c] ?? NJD_CFORM['*'];

// --- pron tokenisation ----------------------------------------------------

/**
 * Split a pron string into mora-sized tokens using the same longest-prefix scan as
 * the C. A trailing devoicing mark stays attached to the mora it applies to, so the
 * tokens are safe boundaries to split an accent phrase on.
 */
export function tokenizePron(pron: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < pron.length) {
    if (pron.startsWith(MORA_LONG_VOWEL, i)) { out.push(MORA_LONG_VOWEL); i += MORA_LONG_VOWEL.length; continue; }
    if (pron.startsWith(MORA_UNVOICE, i)) {
      if (out.length) out[out.length - 1] += MORA_UNVOICE;
      i += MORA_UNVOICE.length;
      continue;
    }
    const hit = MORA_LIST.find((m) => pron.startsWith(m[0], i));
    if (!hit) { i += 1; continue; } // unknown char: skip, matching the C's warn-and-continue
    out.push(hit[0]);
    i += hit[0].length;
  }
  return out;
}

// --- jpcommon structures --------------------------------------------------
// These mirror the C's intrusive linked lists. `up` walks toward the utterance:
// phoneme -> mora -> word -> accent phrase -> breath group.

interface Phoneme { phoneme: string; prev: Phoneme | null; next: Phoneme | null; up: MoraNode | null }
interface MoraNode { mora: string; head: Phoneme; tail: Phoneme; prev: MoraNode | null; next: MoraNode | null; up: Word }
interface Word {
  pron: string; pos: string; ctype: string; cform: string;
  head: MoraNode; tail: MoraNode; prev: Word | null; next: Word | null;
  up: AccentPhraseNode; njdIndex: number;
}
interface AccentPhraseNode {
  accent: number; emotion: string | null;
  head: Word; tail: Word;
  prev: AccentPhraseNode | null; next: AccentPhraseNode | null;
  up: BreathGroup;
}
interface BreathGroup {
  head: AccentPhraseNode; tail: AccentPhraseNode;
  prev: BreathGroup | null; next: BreathGroup | null;
}

// The C builds these incrementally with fields left dangling until the next push
// fills them in, so construction needs the same escape hatch. Every `!` below is a
// spot where the C dereferences unconditionally too.
class LabelState {
  shortPauseFlag = 0;
  breathHead: BreathGroup | null = null;
  breathTail: BreathGroup | null = null;
  accentHead: AccentPhraseNode | null = null;
  accentTail: AccentPhraseNode | null = null;
  wordHead: Word | null = null;
  wordTail: Word | null = null;
  moraHead: MoraNode | null = null;
  moraTail: MoraNode | null = null;
  phonemeHead: Phoneme | null = null;
  phonemeTail: Phoneme | null = null;
  size = 0;
  feature: string[] = [];
}

// --- counting helpers -----------------------------------------------------
// Each walks the *global* mora chain until it reaches a sentinel, as the C does.

function indexMoraInAccentPhrase(m: MoraNode): number {
  let i = 0;
  for (let x: MoraNode | null = m.up.up.head.head; x !== null; x = x.next) { i++; if (x === m) break; }
  return i;
}
function countMoraInAccentPhrase(m: MoraNode): number {
  let i = 0;
  const last = m.up.up.tail.tail;
  for (let x: MoraNode | null = m.up.up.head.head; x !== null; x = x.next) { i++; if (x === last) break; }
  return i;
}
function indexAccentPhraseInBreathGroup(a: AccentPhraseNode): number {
  let i = 0;
  for (let x: AccentPhraseNode | null = a.up.head; x !== null; x = x.next) { i++; if (x === a) break; }
  return i;
}
function countAccentPhraseInBreathGroup(a: AccentPhraseNode): number {
  let i = 0;
  for (let x: AccentPhraseNode | null = a.up.head; x !== null; x = x.next) { i++; if (x === a.up.tail) break; }
  return i;
}
function indexMoraInBreathGroup(m: MoraNode): number {
  let i = 0;
  for (let x: MoraNode | null = m.up.up.up.head.head.head; x !== null; x = x.next) { i++; if (x === m) break; }
  return i;
}
function countMoraInBreathGroup(m: MoraNode): number {
  let i = 0;
  const last = m.up.up.up.tail.tail.tail;
  for (let x: MoraNode | null = m.up.up.up.head.head.head; x !== null; x = x.next) { i++; if (x === last) break; }
  return i;
}
function indexBreathGroupInUtterance(b: BreathGroup): number {
  let i = 0;
  for (let x: BreathGroup | null = b; x !== null; x = x.prev) i++;
  return i;
}
function countBreathGroupInUtterance(b: BreathGroup): number {
  let i = 0;
  for (let x: BreathGroup | null = b.next; x !== null; x = x.next) i++;
  return indexBreathGroupInUtterance(b) + i;
}
function indexAccentPhraseInUtterance(a: AccentPhraseNode): number {
  let i = 0;
  for (let x: AccentPhraseNode | null = a; x !== null; x = x.prev) i++;
  return i;
}
function countAccentPhraseInUtterance(a: AccentPhraseNode): number {
  let i = 0;
  for (let x: AccentPhraseNode | null = a.next; x !== null; x = x.next) i++;
  return indexAccentPhraseInUtterance(a) + i;
}
function indexMoraInUtterance(m: MoraNode): number {
  let i = 0;
  for (let x: MoraNode | null = m; x !== null; x = x.prev) i++;
  return i;
}
function countMoraInUtterance(m: MoraNode): number {
  let i = 0;
  for (let x: MoraNode | null = m.next; x !== null; x = x.next) i++;
  return indexMoraInUtterance(m) + i;
}

// --- construction ---------------------------------------------------------

function insertPause(st: LabelState): void {
  if (st.shortPauseFlag !== 1) return;
  if (st.phonemeTail !== null) {
    if (st.phonemeTail.phoneme === PH_SHORT_PAUSE) return; // pauses are never chained
    const p: Phoneme = { phoneme: PH_SHORT_PAUSE, prev: st.phonemeTail, next: null, up: null };
    st.phonemeTail.next = p;
    st.phonemeTail = p;
  }
  st.shortPauseFlag = 0;
}

function convertUnvoice(p: Phoneme): void {
  const u = UNVOICE[p.phoneme];
  if (u !== undefined) p.phoneme = u;
}

function pushWord(
  st: LabelState,
  pron: string, pos: string, ctype: string, cform: string,
  acc: number, chainFlag: number, njdIndex: number,
): void {
  let isFirstWord = true;

  if (pron === MORA_SHORT_PAUSE) { st.shortPauseFlag = 1; return; }

  if (pron === MORA_QUESTION) {
    if (st.phonemeTail !== null) {
      const anchor = st.phonemeTail.phoneme === PH_SHORT_PAUSE ? st.phonemeTail.prev! : st.phonemeTail;
      const ap = anchor.up!.up.up;
      if (ap.emotion === null) ap.emotion = FLAG_QUESTION;
    }
    st.shortPauseFlag = 1;
    return;
  }

  let rest = pron;
  while (rest.length > 0) {
    if (rest.startsWith(MORA_LONG_VOWEL)) {
      // A long vowel repeats the preceding phoneme as a mora of its own.
      if (st.phonemeTail !== null && st.shortPauseFlag === 0) {
        insertPause(st);
        const prevPh = st.phonemeTail;
        const ph: Phoneme = { phoneme: prevPh.phoneme, prev: prevPh, next: null, up: null };
        prevPh.next = ph;
        const m: MoraNode = {
          mora: MORA_LONG_VOWEL, head: ph, tail: ph,
          prev: st.moraTail, next: null, up: st.moraTail!.up,
        };
        ph.up = m;
        st.moraTail!.next = m;
        st.phonemeTail = ph;
        st.moraTail = m;
        st.wordTail!.tail = m;
      }
      rest = rest.slice(MORA_LONG_VOWEL.length);
      continue;
    }
    if (rest.startsWith(MORA_UNVOICE)) {
      if (st.phonemeTail !== null && !isFirstWord) convertUnvoice(st.phonemeTail);
      rest = rest.slice(MORA_UNVOICE.length);
      continue;
    }

    const hit = MORA_LIST.find((m) => rest.startsWith(m[0]));
    if (!hit) break; // unknown mora: the C warns and stops parsing this word
    const [moraText, consonant, vowel] = hit;

    if (st.phonemeTail === null) {
      // very first mora of the utterance
      insertPause(st);
      const ph: Phoneme = { phoneme: consonant, prev: null, next: null, up: null };
      const m = { mora: moraText, head: ph, tail: ph, prev: null, next: null } as unknown as MoraNode;
      const w = {
        pron, pos: JP_POS[pos] ?? JP_POS['その他'],
        ctype: JP_CTYPE[ctype] ?? JP_CTYPE['*'], cform: JP_CFORM[cform] ?? JP_CFORM['*'],
        head: m, tail: m, prev: null, next: null, njdIndex,
      } as unknown as Word;
      ph.up = m; m.up = w;
      st.phonemeTail = ph; st.moraTail = m; st.wordTail = w;
      st.phonemeHead = ph; st.moraHead = m; st.wordHead = w;
      isFirstWord = false;
    } else if (isFirstWord) {
      // first mora of a new word
      insertPause(st);
      const ph: Phoneme = { phoneme: consonant, prev: st.phonemeTail, next: null, up: null };
      st.phonemeTail.next = ph;
      const m = { mora: moraText, head: ph, tail: ph, prev: st.moraTail, next: null } as unknown as MoraNode;
      st.moraTail!.next = m;
      const w = {
        pron, pos: JP_POS[pos] ?? JP_POS['その他'],
        ctype: JP_CTYPE[ctype] ?? JP_CTYPE['*'], cform: JP_CFORM[cform] ?? JP_CFORM['*'],
        head: m, tail: m, prev: st.wordTail, next: null, njdIndex,
      } as unknown as Word;
      st.wordTail!.next = w;
      ph.up = m; m.up = w;
      st.phonemeTail = ph; st.moraTail = m; st.wordTail = w;
      isFirstWord = false;
    } else {
      // subsequent mora of the current word
      insertPause(st);
      const ph: Phoneme = { phoneme: consonant, prev: st.phonemeTail, next: null, up: null };
      st.phonemeTail.next = ph;
      const m: MoraNode = {
        mora: moraText, head: ph, tail: ph,
        prev: st.moraTail, next: null, up: st.moraTail!.up,
      };
      ph.up = m;
      st.moraTail!.next = m;
      st.phonemeTail = ph;
      st.moraTail = m;
      st.wordTail!.tail = m;
    }

    if (vowel !== null) {
      insertPause(st);
      const ph: Phoneme = { phoneme: vowel, prev: st.phonemeTail, next: null, up: st.moraTail! };
      st.phonemeTail!.next = ph;
      st.phonemeTail = ph;
      st.moraTail!.tail = ph;
    }
    rest = rest.slice(moraText.length);
  }

  if (isFirstWord) return;
  if (st.phonemeTail === null) return;
  if (st.phonemeTail.phoneme === PH_SHORT_PAUSE) return;

  // Attach the freshly pushed word to an accent phrase / breath group.
  const word = st.wordTail!;
  if (st.wordHead === st.wordTail) {
    const a = { accent: acc, emotion: null, head: word, tail: word, prev: null, next: null } as unknown as AccentPhraseNode;
    const b: BreathGroup = { head: a, tail: a, prev: null, next: null };
    a.up = b;
    word.up = a;
    st.accentHead = st.accentTail = a;
    st.breathHead = st.breathTail = b;
  } else if (chainFlag === 1) {
    // continues the current accent phrase
    word.up = st.accentTail!;
    st.accentTail!.tail = word;
  } else if (word.prev!.tail.tail.next!.phoneme !== PH_SHORT_PAUSE) {
    // new accent phrase, same breath group
    const a: AccentPhraseNode = {
      accent: acc, emotion: null, head: word, tail: word,
      prev: st.accentTail, next: null, up: st.breathTail!,
    };
    st.accentTail!.next = a;
    word.up = a;
    st.breathTail!.tail = a;
    st.accentTail = a;
  } else {
    // a pause intervened, so this starts a new breath group too
    const a = {
      accent: acc, emotion: null, head: word, tail: word,
      prev: st.accentTail, next: null,
    } as unknown as AccentPhraseNode;
    const b: BreathGroup = { head: a, tail: a, prev: st.breathTail, next: null };
    a.up = b;
    st.accentTail!.next = a;
    st.breathTail!.next = b;
    word.up = a;
    st.accentTail = a;
    st.breathTail = b;
  }
}

function makeFeatures(st: LabelState): void {
  let n = 0;
  for (let p = st.phonemeHead; p !== null; p = p.next) n++;
  if (n < 1) { st.size = 0; st.feature = []; return; }
  st.size = n + 2;

  // Padded phoneme window: xx xx sil <phonemes> sil xx xx
  const ph: string[] = new Array(st.size + 4);
  ph[0] = PH_UNKNOWN; ph[1] = PH_UNKNOWN; ph[2] = PH_SILENT;
  ph[st.size + 1] = PH_SILENT; ph[st.size + 2] = PH_UNKNOWN; ph[st.size + 3] = PH_UNKNOWN;
  { let i = 3; for (let p = st.phonemeHead; p !== null; p = p.next) ph[i++] = p.phoneme; }

  const feature: string[] = [];
  let p = st.phonemeHead!;
  for (let i = 0; i < st.size; i++) {
    const isPause = p.phoneme === PH_SHORT_PAUSE;
    const isEdge = i === 0 || i === st.size - 1;
    let s = `${ph[i]}^${ph[i + 1]}-${ph[i + 2]}+${ph[i + 3]}=${ph[i + 4]}`;

    // A: mora position relative to the accent nucleus
    if (isEdge || isPause) s += '/A:xx+xx+xx';
    else {
      const m = p.up!;
      const t1 = indexMoraInAccentPhrase(m);
      const ap = m.up.up;
      const t2 = ap.accent === 0 ? countMoraInAccentPhrase(m) : ap.accent;
      s += `/A:${limit(t1 - t2, -MAX_M, MAX_M)}+${limit(t1, 1, MAX_M)}+${limit(countMoraInAccentPhrase(m) - t1 + 1, 1, MAX_M)}`;
    }

    // B: previous word
    let w: Word | null;
    if (isPause) w = p.prev!.up!.up;
    else if (p.up!.up.prev === null) w = null;
    else if (i === st.size - 1) w = p.up!.up;
    else w = p.up!.up.prev;
    s += w === null ? '/B:xx-xx_xx' : `/B:${w.pos}-${w.ctype}_${w.cform}`;

    // C: current word
    s += (isEdge || isPause) ? '/C:xx_xx+xx' : `/C:${p.up!.up.pos}_${p.up!.up.ctype}+${p.up!.up.cform}`;

    // D: next word
    if (isPause) w = p.next!.up!.up;
    else if (p.up!.up.next === null) w = null;
    else if (i === 0) w = p.up!.up;
    else w = p.up!.up.next;
    s += w === null ? '/D:xx+xx_xx' : `/D:${w.pos}+${w.ctype}_${w.cform}`;

    // E: previous accent phrase
    let a: AccentPhraseNode | null;
    if (isPause) a = p.prev!.up!.up.up;
    else if (i === st.size - 1) a = p.up!.up.up;
    else a = p.up!.up.up.prev;
    if (a === null) s += '/E:xx_xx!xx_xx';
    else {
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/E:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}!${a.emotion ?? '0'}_xx`;
    }
    s += (isEdge || isPause || a === null) ? '-xx'
      : `-${a.tail.tail.tail.next!.phoneme === PH_SHORT_PAUSE ? 0 : 1}`;

    // F: current accent phrase
    a = (isEdge || isPause) ? null : p.up!.up.up;
    if (a === null) s += '/F:xx_xx#xx_xx@xx_xx|xx_xx';
    else {
      const t1 = indexAccentPhraseInBreathGroup(a);
      const t2 = indexMoraInBreathGroup(a.head.head);
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/F:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}`
        + `#${a.emotion ?? '0'}_xx`
        + `@${limit(t1, 1, MAX_M)}_${limit(countAccentPhraseInBreathGroup(a) - t1 + 1, 1, MAX_M)}`
        + `|${limit(t2, 1, MAX_L)}_${limit(countMoraInBreathGroup(a.head.head) - t2 + 1, 1, MAX_L)}`;
    }

    // G: next accent phrase
    if (isPause) a = p.next!.up!.up.up;
    else if (i === 0) a = p.up!.up.up;
    else a = p.up!.up.up.next;
    if (a === null) s += '/G:xx_xx%xx_xx';
    else {
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/G:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}%${a.emotion ?? '0'}_xx`;
    }
    s += (isEdge || isPause || a === null) ? '_xx'
      : `_${a.head.head.head.prev!.phoneme === PH_SHORT_PAUSE ? 0 : 1}`;

    // H: previous breath group
    let b: BreathGroup | null;
    if (isPause) b = p.prev!.up!.up.up.up;
    else if (i === st.size - 1) b = p.up!.up.up.up;
    else b = p.up!.up.up.up.prev;
    s += b === null ? '/H:xx_xx'
      : `/H:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}_${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}`;

    // I: current breath group
    b = (isEdge || isPause) ? null : p.up!.up.up.up;
    if (b === null) s += '/I:xx-xx@xx+xx&xx-xx|xx+xx';
    else {
      const t1 = indexBreathGroupInUtterance(b);
      const t2 = indexAccentPhraseInUtterance(b.head);
      const t3 = indexMoraInUtterance(b.head.head.head);
      s += `/I:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}-${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}`
        + `@${limit(t1, 1, MAX_S)}+${limit(countBreathGroupInUtterance(b) - t1 + 1, 1, MAX_S)}`
        + `&${limit(t2, 1, MAX_M)}-${limit(countAccentPhraseInUtterance(b.head) - t2 + 1, 1, MAX_M)}`
        + `|${limit(t3, 1, MAX_LL)}+${limit(countMoraInUtterance(b.head.head.head) - t3 + 1, 1, MAX_LL)}`;
    }

    // J: next breath group
    if (isPause) b = p.next!.up!.up.up.up;
    else if (i === 0) b = p.up!.up.up.up;
    else b = p.up!.up.up.up.next;
    s += b === null ? '/J:xx_xx'
      : `/J:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}_${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}`;

    // K: whole utterance
    s += `/K:${limit(countBreathGroupInUtterance(st.breathHead!), 1, MAX_S)}`
      + `+${limit(countAccentPhraseInUtterance(st.accentHead!), 1, MAX_M)}`
      + `-${limit(countMoraInUtterance(st.moraHead!), 1, MAX_LL)}`;

    feature.push(s);
    if (i > 0 && i < st.size - 2) p = p.next!;
  }
  st.feature = feature;
}

/** Walk the built structure and expose it as plain data for the renderer. */
function readAccentPhrases(st: LabelState): AccentPhrase[] {
  const phrases: AccentPhrase[] = [];
  let bgIndex = 0;
  for (let b = st.breathHead; b !== null; b = b.next) {
    for (let a: AccentPhraseNode | null = b.head; a !== null; a = a.next) {
      const moras: Mora[] = [];
      const words: { njdIndex: number; moraCount: number }[] = [];
      for (let w: Word | null = a.head; w !== null; w = w.next) {
        const wordMoras: Mora[] = [];
        for (let m: MoraNode | null = w.head; m !== null; m = m.next) {
          const phonemes: string[] = [];
          for (let p: Phoneme | null = m.head; p !== null; p = p.next) {
            phonemes.push(p.phoneme);
            if (p === m.tail) break;
          }
          wordMoras.push({ text: m.mora, phonemes, njdIndex: w.njdIndex });
          if (m === w.tail) break;
        }
        words.push({ njdIndex: w.njdIndex, moraCount: wordMoras.length });
        moras.push(...wordMoras);
        if (w === a.tail) break;
      }
      phrases.push({
        accent: a.accent,
        moraCount: moras.length,
        moras,
        words,
        headNjdIndex: a.head.njdIndex,
        breathGroup: bgIndex,
        isQuestion: a.emotion !== null,
      });
      if (a === b.tail) break;
    }
    bgIndex++;
  }
  return phrases;
}

/**
 * Build full-context labels plus a renderer-facing accent-phrase view from NJD nodes.
 * Edits the user makes (pron, acc, chainFlag) are simply reflected in `njd`.
 */
export function buildLabel(njd: NjdNode[]): LabelResult {
  const st = new LabelState();
  njd.forEach((node, idx) => {
    pushWord(
      st,
      node.pron,
      convertPos(node.pos, node.posGroup1, node.posGroup2, node.posGroup3),
      convertCtype(node.ctype),
      convertCform(node.cform),
      node.acc,
      node.chainFlag,
      idx,
    );
  });
  makeFeatures(st);
  return { features: st.feature, accentPhrases: readAccentPhrases(st) };
}
