'use strict';
// Port of Open JTalk 1.11 njd2jpcommon + jpcommon_label.
//
// Field layout follows "An example of context-dependent label format for HMM-based
// speech synthesis in Japanese" (HTS Working Group, 2015-12-25); see lab_format.pdf.
// Note the spec names b2/b3 "inflected forms"/"conjugation type", but the C emits
// pos-ctype_cform in that order. We follow the C, since the shipped voices were
// trained against labels the C produced.
//
// Given the NJD morpheme list that open_jtalk's text analysis produced (optionally
// with user edits to pron / accent / chain_flag), this rebuilds the HTS full-context
// labels that hts_engine consumes. Structure and field order mirror the C so the two
// can be diffed line for line -- see test/validate-labels.js.

const { MORA_LIST, UNVOICE, JP_POS, JP_CFORM, JP_CTYPE, NJD_POS, NJD_CFORM, NJD_CTYPE } = require('./tables');

const MORA_UNVOICE = '’';      // ’
const MORA_LONG_VOWEL = 'ー';   // ー
const MORA_SHORT_PAUSE = '、';  // 、
const MORA_QUESTION = '？';     // ？
const PH_SHORT_PAUSE = 'pau';
const PH_SILENT = 'sil';
const PH_UNKNOWN = 'xx';
const FLAG_QUESTION = '1';

const MAX_S = 19, MAX_M = 49, MAX_L = 99, MAX_LL = 199;

const limit = (v, min, max) => (v <= min ? min : v >= max ? max : v);

// --- njd2jpcommon ---------------------------------------------------------

function convertPos(pos, g1, g2, g3) {
  for (const row of NJD_POS) {
    if (row[0] === pos && row[1] === g1 && row[2] === g2 && row[3] === g3) return row[4];
  }
  return NJD_POS[0][4]; // C falls back to njd2jpcommon_pos_list[4] == "その他"
}
const convertCtype = (c) => (c in NJD_CTYPE ? NJD_CTYPE[c] : NJD_CTYPE['*']);
const convertCform = (c) => (c in NJD_CFORM ? NJD_CFORM[c] : NJD_CFORM['*']);

// --- pron tokenisation ----------------------------------------------------

// Split a pron string into mora-sized tokens using the same longest-prefix scan
// as the C. A trailing unvoice mark stays attached to the mora it devoices.
function tokenizePron(pron) {
  const out = [];
  let i = 0;
  while (i < pron.length) {
    if (pron.startsWith(MORA_LONG_VOWEL, i)) { out.push(MORA_LONG_VOWEL); i += MORA_LONG_VOWEL.length; continue; }
    if (pron.startsWith(MORA_UNVOICE, i)) {
      if (out.length) out[out.length - 1] += MORA_UNVOICE;
      i += MORA_UNVOICE.length;
      continue;
    }
    const hit = MORA_LIST.find((m) => pron.startsWith(m[0], i));
    if (!hit) { i += 1; continue; } // unknown char: skip, matching the C's warn-and-bail intent
    out.push(hit[0]);
    i += hit[0].length;
  }
  return out;
}

// --- jpcommon_label -------------------------------------------------------

class Label {
  constructor() {
    this.shortPauseFlag = 0;
    this.breathHead = null; this.breathTail = null;
    this.accentHead = null; this.accentTail = null;
    this.wordHead = null; this.wordTail = null;
    this.moraHead = null; this.moraTail = null;
    this.phonemeHead = null; this.phonemeTail = null;
    this.size = 0;
    this.feature = [];
  }
}

const newPhoneme = (phoneme, prev, next, up) => ({ phoneme, prev, next, up });
const newMora = (mora, head, tail, prev, next, up) => ({ mora, head, tail, prev, next, up });

function newWord(pron, pos, ctype, cform, head, tail, prev, next, njdIndex) {
  return {
    pron,
    pos: pos in JP_POS ? JP_POS[pos] : JP_POS['その他'],
    ctype: ctype in JP_CTYPE ? JP_CTYPE[ctype] : JP_CTYPE['*'],
    cform: cform in JP_CFORM ? JP_CFORM[cform] : JP_CFORM['*'],
    head, tail, prev, next, up: null, njdIndex,
  };
}

const newAccentPhrase = (accent, emotion, head, tail, prev, next, up) =>
  ({ accent, emotion, head, tail, prev, next, up });
const newBreathGroup = (head, tail, prev, next) => ({ head, tail, prev, next });

// counting helpers -- these walk the global mora chain until they hit a sentinel,
// exactly as the C versions do.
function indexMoraInAccentPhrase(m) {
  let i = 0;
  for (let x = m.up.up.head.head; x !== null; x = x.next) { i++; if (x === m) break; }
  return i;
}
function countMoraInAccentPhrase(m) {
  let i = 0;
  const last = m.up.up.tail.tail;
  for (let x = m.up.up.head.head; x !== null; x = x.next) { i++; if (x === last) break; }
  return i;
}
function indexAccentPhraseInBreathGroup(a) {
  let i = 0;
  for (let x = a.up.head; x !== null; x = x.next) { i++; if (x === a) break; }
  return i;
}
function countAccentPhraseInBreathGroup(a) {
  let i = 0;
  for (let x = a.up.head; x !== null; x = x.next) { i++; if (x === a.up.tail) break; }
  return i;
}
function indexMoraInBreathGroup(m) {
  let i = 0;
  for (let x = m.up.up.up.head.head.head; x !== null; x = x.next) { i++; if (x === m) break; }
  return i;
}
function countMoraInBreathGroup(m) {
  let i = 0;
  const last = m.up.up.up.tail.tail.tail;
  for (let x = m.up.up.up.head.head.head; x !== null; x = x.next) { i++; if (x === last) break; }
  return i;
}
function indexBreathGroupInUtterance(b) { let i = 0; for (let x = b; x !== null; x = x.prev) i++; return i; }
function countBreathGroupInUtterance(b) {
  let i = 0; for (let x = b.next; x !== null; x = x.next) i++;
  return indexBreathGroupInUtterance(b) + i;
}
function indexAccentPhraseInUtterance(a) { let i = 0; for (let x = a; x !== null; x = x.prev) i++; return i; }
function countAccentPhraseInUtterance(a) {
  let i = 0; for (let x = a.next; x !== null; x = x.next) i++;
  return indexAccentPhraseInUtterance(a) + i;
}
function indexMoraInUtterance(m) { let i = 0; for (let x = m; x !== null; x = x.prev) i++; return i; }
function countMoraInUtterance(m) {
  let i = 0; for (let x = m.next; x !== null; x = x.next) i++;
  return indexMoraInUtterance(m) + i;
}

function insertPause(label) {
  if (label.shortPauseFlag === 1) {
    if (label.phonemeTail !== null) {
      if (label.phonemeTail.phoneme === PH_SHORT_PAUSE) return; // never chain pauses
      label.phonemeTail.next = newPhoneme(PH_SHORT_PAUSE, label.phonemeTail, null, null);
      label.phonemeTail = label.phonemeTail.next;
    }
    label.shortPauseFlag = 0;
  }
}

function convertUnvoice(p) { if (p.phoneme in UNVOICE) p.phoneme = UNVOICE[p.phoneme]; }

function pushWord(label, pron, pos, ctype, cform, acc, chainFlag, njdIndex) {
  let isFirstWord = 1;

  if (pron === MORA_SHORT_PAUSE) { label.shortPauseFlag = 1; return; }

  if (pron === MORA_QUESTION) {
    if (label.phonemeTail !== null) {
      const target = label.phonemeTail.phoneme === PH_SHORT_PAUSE
        ? label.phonemeTail.prev.up.up.up
        : label.phonemeTail.up.up.up;
      if (target.emotion === null) target.emotion = FLAG_QUESTION;
    }
    label.shortPauseFlag = 1;
    return;
  }

  let rest = pron;
  while (rest.length > 0) {
    if (rest.startsWith(MORA_LONG_VOWEL)) {
      if (label.phonemeTail !== null && label.shortPauseFlag === 0) {
        insertPause(label);
        // A long vowel repeats the previous phoneme as a mora of its own.
        label.phonemeTail.next = newPhoneme(label.phonemeTail.phoneme, label.phonemeTail, null, null);
        label.moraTail.next = newMora(MORA_LONG_VOWEL, label.phonemeTail.next, label.phonemeTail.next,
                                      label.moraTail, null, label.moraTail.up);
        label.phonemeTail.next.up = label.moraTail.next;
        label.phonemeTail = label.phonemeTail.next;
        label.moraTail = label.moraTail.next;
        label.wordTail.tail = label.moraTail;
      }
      rest = rest.slice(MORA_LONG_VOWEL.length);
      continue;
    }
    if (rest.startsWith(MORA_UNVOICE)) {
      if (label.phonemeTail !== null && isFirstWord !== 1) convertUnvoice(label.phonemeTail);
      rest = rest.slice(MORA_UNVOICE.length);
      continue;
    }
    const hit = MORA_LIST.find((m) => rest.startsWith(m[0]));
    if (!hit) break;
    const [moraText, consonant, vowel] = hit;

    if (label.phonemeTail === null) {
      insertPause(label);
      label.phonemeTail = newPhoneme(consonant, null, null, null);
      label.moraTail = newMora(moraText, label.phonemeTail, label.phonemeTail, null, null, null);
      label.wordTail = newWord(pron, pos, ctype, cform, label.moraTail, label.moraTail, null, null, njdIndex);
      label.phonemeTail.up = label.moraTail;
      label.moraTail.up = label.wordTail;
      label.phonemeHead = label.phonemeTail;
      label.moraHead = label.moraTail;
      label.wordHead = label.wordTail;
      isFirstWord = 0;
    } else if (isFirstWord === 1) {
      insertPause(label);
      label.phonemeTail.next = newPhoneme(consonant, label.phonemeTail, null, null);
      label.moraTail.next = newMora(moraText, label.phonemeTail.next, label.phonemeTail.next, label.moraTail, null, null);
      label.wordTail.next = newWord(pron, pos, ctype, cform, label.moraTail.next, label.moraTail.next, label.wordTail, null, njdIndex);
      label.phonemeTail.next.up = label.moraTail.next;
      label.moraTail.next.up = label.wordTail.next;
      label.phonemeTail = label.phonemeTail.next;
      label.moraTail = label.moraTail.next;
      label.wordTail = label.wordTail.next;
      isFirstWord = 0;
    } else {
      insertPause(label);
      label.phonemeTail.next = newPhoneme(consonant, label.phonemeTail, null, null);
      label.moraTail.next = newMora(moraText, label.phonemeTail.next, label.phonemeTail.next,
                                    label.moraTail, null, label.moraTail.up);
      label.phonemeTail.next.up = label.moraTail.next;
      label.phonemeTail = label.phonemeTail.next;
      label.moraTail = label.moraTail.next;
      label.wordTail.tail = label.moraTail;
    }

    if (vowel !== null) {
      insertPause(label);
      label.phonemeTail.next = newPhoneme(vowel, label.phonemeTail, null, label.moraTail);
      label.phonemeTail = label.phonemeTail.next;
      label.moraTail.tail = label.phonemeTail;
    }
    rest = rest.slice(moraText.length);
  }

  if (isFirstWord === 1) return;
  if (label.phonemeTail === null) return;
  if (label.phonemeTail.phoneme === PH_SHORT_PAUSE) return;

  // Attach the freshly pushed word to an accent phrase / breath group.
  if (label.wordHead === label.wordTail) {
    label.accentTail = newAccentPhrase(acc, null, label.wordTail, label.wordTail, null, null, null);
    label.breathTail = newBreathGroup(label.accentTail, label.accentTail, null, null);
    label.accentTail.up = label.breathTail;
    label.wordTail.up = label.accentTail;
    label.accentHead = label.accentTail;
    label.breathHead = label.breathTail;
  } else if (chainFlag === 1) {
    label.wordTail.up = label.accentTail;
    label.accentTail.tail = label.wordTail;
  } else if (label.wordTail.prev.tail.tail.next.phoneme !== PH_SHORT_PAUSE) {
    // new accent phrase, same breath group
    label.accentTail.next = newAccentPhrase(acc, null, label.wordTail, label.wordTail, label.accentTail, null, label.breathTail);
    label.wordTail.up = label.accentTail.next;
    label.breathTail.tail = label.accentTail.next;
    label.accentTail = label.accentTail.next;
  } else {
    // a pause intervened: new accent phrase and new breath group
    label.accentTail.next = newAccentPhrase(acc, null, label.wordTail, label.wordTail, label.accentTail, null, null);
    label.breathTail.next = newBreathGroup(label.accentTail.next, label.accentTail.next, label.breathTail, null);
    label.accentTail.next.up = label.breathTail.next;
    label.wordTail.up = label.accentTail.next;
    label.accentTail = label.accentTail.next;
    label.breathTail = label.breathTail.next;
  }
}

function makeFeatures(label) {
  let n = 0;
  for (let p = label.phonemeHead; p !== null; p = p.next) n++;
  if (n < 1) { label.size = 0; label.feature = []; return; }
  label.size = n + 2;

  const ph = new Array(label.size + 4);
  ph[0] = PH_UNKNOWN; ph[1] = PH_UNKNOWN; ph[2] = PH_SILENT;
  ph[label.size + 1] = PH_SILENT; ph[label.size + 2] = PH_UNKNOWN; ph[label.size + 3] = PH_UNKNOWN;
  { let i = 3; for (let p = label.phonemeHead; p !== null; p = p.next) ph[i++] = p.phoneme; }

  const feature = [];
  let p = label.phonemeHead;
  for (let i = 0; i < label.size; i++) {
    const isPause = p.phoneme === PH_SHORT_PAUSE;
    const isEdge = i === 0 || i === label.size - 1;
    let s = `${ph[i]}^${ph[i + 1]}-${ph[i + 2]}+${ph[i + 3]}=${ph[i + 4]}`;

    // A: mora position relative to the accent nucleus
    if (isEdge || isPause) s += '/A:xx+xx+xx';
    else {
      const t1 = indexMoraInAccentPhrase(p.up);
      const t2 = p.up.up.up.accent === 0 ? countMoraInAccentPhrase(p.up) : p.up.up.up.accent;
      s += `/A:${limit(t1 - t2, -MAX_M, MAX_M)}+${limit(t1, 1, MAX_M)}+${limit(countMoraInAccentPhrase(p.up) - t1 + 1, 1, MAX_M)}`;
    }

    // B: previous word
    let w;
    if (isPause) w = p.prev.up.up;
    else if (p.up.up.prev === null) w = null;
    else if (i === label.size - 1) w = p.up.up;
    else w = p.up.up.prev;
    s += w === null ? '/B:xx-xx_xx' : `/B:${w.pos}-${w.ctype}_${w.cform}`;

    // C: current word
    s += (isEdge || isPause) ? '/C:xx_xx+xx' : `/C:${p.up.up.pos}_${p.up.up.ctype}+${p.up.up.cform}`;

    // D: next word
    if (isPause) w = p.next.up.up;
    else if (p.up.up.next === null) w = null;
    else if (i === 0) w = p.up.up;
    else w = p.up.up.next;
    s += w === null ? '/D:xx+xx_xx' : `/D:${w.pos}+${w.ctype}_${w.cform}`;

    // E: previous accent phrase
    let a;
    if (isPause) a = p.prev.up.up.up;
    else if (i === label.size - 1) a = p.up.up.up;
    else a = p.up.up.up.prev;
    if (a === null) s += '/E:xx_xx!xx_xx';
    else {
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/E:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}!${a.emotion === null ? '0' : a.emotion}_xx`;
    }
    s += (isEdge || isPause || a === null) ? '-xx'
      : `-${a.tail.tail.tail.next.phoneme === PH_SHORT_PAUSE ? 0 : 1}`;

    // F: current accent phrase
    a = (isEdge || isPause) ? null : p.up.up.up;
    if (a === null) s += '/F:xx_xx#xx_xx@xx_xx|xx_xx';
    else {
      const t1 = indexAccentPhraseInBreathGroup(a);
      const t2 = indexMoraInBreathGroup(a.head.head);
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/F:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}` +
           `#${a.emotion === null ? '0' : a.emotion}_xx` +
           `@${limit(t1, 1, MAX_M)}_${limit(countAccentPhraseInBreathGroup(a) - t1 + 1, 1, MAX_M)}` +
           `|${limit(t2, 1, MAX_L)}_${limit(countMoraInBreathGroup(a.head.head) - t2 + 1, 1, MAX_L)}`;
    }

    // G: next accent phrase
    if (isPause) a = p.next.up.up.up;
    else if (i === 0) a = p.up.up.up;
    else a = p.up.up.up.next;
    if (a === null) s += '/G:xx_xx%xx_xx';
    else {
      const mc = countMoraInAccentPhrase(a.head.head);
      s += `/G:${limit(mc, 1, MAX_M)}_${limit(a.accent === 0 ? mc : a.accent, 1, MAX_M)}%${a.emotion === null ? '0' : a.emotion}_xx`;
    }
    s += (isEdge || isPause || a === null) ? '_xx'
      : `_${a.head.head.head.prev.phoneme === PH_SHORT_PAUSE ? 0 : 1}`;

    // H: previous breath group
    let b;
    if (isPause) b = p.prev.up.up.up.up;
    else if (i === label.size - 1) b = p.up.up.up.up;
    else b = p.up.up.up.up.prev;
    s += b === null ? '/H:xx_xx'
      : `/H:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}_${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}`;

    // I: current breath group
    b = (isEdge || isPause) ? null : p.up.up.up.up;
    if (b === null) s += '/I:xx-xx@xx+xx&xx-xx|xx+xx';
    else {
      const t1 = indexBreathGroupInUtterance(b);
      const t2 = indexAccentPhraseInUtterance(b.head);
      const t3 = indexMoraInUtterance(b.head.head.head);
      s += `/I:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}-${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}` +
           `@${limit(t1, 1, MAX_S)}+${limit(countBreathGroupInUtterance(b) - t1 + 1, 1, MAX_S)}` +
           `&${limit(t2, 1, MAX_M)}-${limit(countAccentPhraseInUtterance(b.head) - t2 + 1, 1, MAX_M)}` +
           `|${limit(t3, 1, MAX_LL)}+${limit(countMoraInUtterance(b.head.head.head) - t3 + 1, 1, MAX_LL)}`;
    }

    // J: next breath group
    if (isPause) b = p.next.up.up.up.up;
    else if (i === 0) b = p.up.up.up.up;
    else b = p.up.up.up.up.next;
    s += b === null ? '/J:xx_xx'
      : `/J:${limit(countAccentPhraseInBreathGroup(b.head), 1, MAX_M)}_${limit(countMoraInBreathGroup(b.head.head.head), 1, MAX_L)}`;

    // K: whole utterance
    s += `/K:${limit(countBreathGroupInUtterance(label.breathHead), 1, MAX_S)}` +
         `+${limit(countAccentPhraseInUtterance(label.accentHead), 1, MAX_M)}` +
         `-${limit(countMoraInUtterance(label.moraHead), 1, MAX_LL)}`;

    feature.push(s);
    if (i > 0 && i < label.size - 2) p = p.next;
  }
  label.feature = feature;
}

// --- public API -----------------------------------------------------------

/**
 * Build full-context labels plus a UI-facing accent-phrase view from NJD nodes.
 * @param {Array} njd nodes as produced by njd.js (pron / acc / chainFlag may be edited)
 */
function buildLabel(njd) {
  const label = new Label();
  njd.forEach((node, idx) => {
    pushWord(
      label,
      node.pron,
      convertPos(node.pos, node.posGroup1, node.posGroup2, node.posGroup3),
      convertCtype(node.ctype),
      convertCform(node.cform),
      node.acc,
      node.chainFlag,
      idx,
    );
  });
  makeFeatures(label);
  return { features: label.feature, accentPhrases: readAccentPhrases(label) };
}

// Walk the built structure and expose it as plain data for the renderer.
function readAccentPhrases(label) {
  const phrases = [];
  let bgIndex = 0;
  for (let b = label.breathHead; b !== null; b = b.next) {
    for (let a = b.head; a !== null; a = a.next) {
      const moras = [];
      const words = [];
      for (let w = a.head; w !== null; w = w.next) {
        const wordMoras = [];
        for (let m = w.head; m !== null; m = m.next) {
          const phonemes = [];
          for (let p = m.head; p !== null; p = p.next) { phonemes.push(p.phoneme); if (p === m.tail) break; }
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

module.exports = { buildLabel, tokenizePron, MORA_LONG_VOWEL, MORA_UNVOICE, MORA_SHORT_PAUSE, MORA_QUESTION };
