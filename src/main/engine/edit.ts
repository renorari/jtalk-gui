// Accent editing, expressed as operations on the NJD morpheme list.
//
// Every edit changes only three things Open JTalk itself derives -- a word's accent
// nucleus (`acc`), whether it continues the previous accent phrase (`chainFlag`), or
// its reading (`pron`). Labels are then rebuilt from scratch by label.ts, so an edited
// utterance goes through exactly the same code path as an unedited one.

import { tokenizePron, MORA_SHORT_PAUSE, MORA_LONG_VOWEL } from './label';
import type { NjdNode, AccentPhrase } from '../../shared/types';

const clone = (njd: NjdNode[]): NjdNode[] => njd.map((n) => ({ ...n }));

/** A '、' morpheme, which Open JTalk turns into a pause and a breath-group break. */
function pauseNode(): NjdNode {
  return {
    string: MORA_SHORT_PAUSE, pos: '記号', posGroup1: '読点', posGroup2: '*', posGroup3: '*',
    ctype: '*', cform: '*', orig: MORA_SHORT_PAUSE, read: MORA_SHORT_PAUSE, pron: MORA_SHORT_PAUSE,
    acc: 0, moraSize: 0, chainRule: '*', chainFlag: 1,
  };
}

/**
 * Set an accent phrase's nucleus. 0 is heiban (flat); otherwise it is the 1-based
 * mora the pitch falls after. The phrase takes its accent from its head word.
 */
export function setAccent(njd: NjdNode[], phrase: AccentPhrase, accent: number): NjdNode[] {
  const next = clone(njd);
  const head = next[phrase.headNjdIndex];
  if (!head) return next;
  head.acc = Math.max(0, Math.min(accent, phrase.moraCount));
  return next;
}

/** Merge an accent phrase into the one before it. */
export function mergeWithPrevious(njd: NjdNode[], phrase: AccentPhrase): NjdNode[] {
  const next = clone(njd);
  const head = next[phrase.headNjdIndex];
  if (!head || phrase.headNjdIndex === 0) return next;
  head.chainFlag = 1;
  return next;
}

/**
 * Split an accent phrase so that `moraIndex` (0-based, within the phrase) begins a
 * new one. When the split falls inside a word the word itself is divided, so the
 * boundary need not line up with the morphology.
 */
export function splitAt(njd: NjdNode[], phrase: AccentPhrase, moraIndex: number): NjdNode[] {
  if (moraIndex <= 0 || moraIndex >= phrase.moraCount) return clone(njd);

  // Walk the phrase's words to find which one contains this mora, and where.
  let consumed = 0;
  for (const word of phrase.words) {
    if (moraIndex === consumed) {
      // Clean word boundary: just break the chain here.
      const next = clone(njd);
      const node = next[word.njdIndex];
      if (node) node.chainFlag = 0;
      return next;
    }
    if (moraIndex < consumed + word.moraCount) {
      return splitWord(njd, word.njdIndex, moraIndex - consumed);
    }
    consumed += word.moraCount;
  }
  return clone(njd);
}

/**
 * Divide one morpheme into two at a mora boundary, with the second half starting a
 * new accent phrase. Used when the user splits mid-word.
 */
export function splitWord(njd: NjdNode[], njdIndex: number, moraOffset: number): NjdNode[] {
  const next = clone(njd);
  const node = next[njdIndex];
  if (!node) return next;

  const moras = tokenizePron(node.pron);
  if (moraOffset <= 0 || moraOffset >= moras.length) return next;
  // A long-vowel mark copies the phoneme before it, so it can never lead a phrase.
  if (moras[moraOffset] === MORA_LONG_VOWEL) return next;

  const leftPron = moras.slice(0, moraOffset).join('');
  const rightPron = moras.slice(moraOffset).join('');

  const left: NjdNode = {
    ...node,
    pron: leftPron,
    moraSize: moraOffset,
    // Keep the nucleus only if it still falls inside this half.
    acc: node.acc > 0 && node.acc <= moraOffset ? node.acc : 0,
  };
  const right: NjdNode = {
    ...node,
    string: '',
    orig: '',
    read: '',
    pron: rightPron,
    moraSize: moras.length - moraOffset,
    acc: node.acc > moraOffset ? node.acc - moraOffset : 0,
    chainFlag: 0,
  };

  next.splice(njdIndex, 1, left, right);
  return next;
}

/** Replace a word's reading. Accepts katakana plus the 'ー' and '’' marks. */
export function setPron(njd: NjdNode[], njdIndex: number, pron: string): NjdNode[] {
  const next = clone(njd);
  const node = next[njdIndex];
  if (!node) return next;
  const moras = tokenizePron(pron);
  node.pron = pron;
  node.moraSize = moras.length;
  if (node.acc > moras.length) node.acc = 0;
  return next;
}

/** Insert a pause before the given accent phrase, breaking the breath group. */
export function insertPauseBefore(njd: NjdNode[], phrase: AccentPhrase): NjdNode[] {
  const next = clone(njd);
  if (phrase.headNjdIndex <= 0) return next;
  const before = next[phrase.headNjdIndex - 1];
  if (before && before.pron === MORA_SHORT_PAUSE) return next; // already paused
  const head = next[phrase.headNjdIndex];
  if (head) head.chainFlag = 0;
  next.splice(phrase.headNjdIndex, 0, pauseNode());
  return next;
}

/** Remove the pause immediately before the given accent phrase, if there is one. */
export function removePauseBefore(njd: NjdNode[], phrase: AccentPhrase): NjdNode[] {
  const next = clone(njd);
  const idx = phrase.headNjdIndex - 1;
  if (idx < 0) return next;
  if (next[idx]?.pron !== MORA_SHORT_PAUSE) return next;
  next.splice(idx, 1);
  return next;
}

/** True when a pause sits immediately before this phrase. */
export function hasPauseBefore(njd: NjdNode[], phrase: AccentPhrase): boolean {
  const idx = phrase.headNjdIndex - 1;
  return idx >= 0 && njd[idx]?.pron === MORA_SHORT_PAUSE;
}

/**
 * The high/low pattern a phrase is rendered with, following the standard Japanese
 * pitch-accent rules: heiban rises after the first mora and stays high; an accented
 * phrase falls after the nucleus; a nucleus on mora 1 starts high.
 */
export function pitchPattern(accent: number, moraCount: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 1; i <= moraCount; i++) {
    if (accent === 1) out.push(i === 1);
    else if (accent === 0) out.push(i !== 1);
    else out.push(i !== 1 && i <= accent);
  }
  return out;
}
