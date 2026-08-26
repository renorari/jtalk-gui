// Types shared between the Electron main process and the renderer.

/** One morpheme as produced by Open JTalk's text analysis (NJDNode_fprint). */
export interface NjdNode {
  string: string;
  pos: string;
  posGroup1: string;
  posGroup2: string;
  posGroup3: string;
  ctype: string;
  cform: string;
  orig: string;
  read: string;
  /** Katakana pronunciation; may carry 'ー' (long vowel) and '’' (devoiced) marks. */
  pron: string;
  /** Accent nucleus position, 1-based. 0 means flat (heiban). */
  acc: number;
  moraSize: number;
  chainRule: string;
  /** 1 = continues the previous accent phrase, 0 = starts a new one, -1 = undecided. */
  chainFlag: number;
}

export interface Mora {
  text: string;
  phonemes: string[];
  /** Index into the NJD array of the word this mora came from. */
  njdIndex: number;
}

export interface AccentPhraseWord {
  njdIndex: number;
  moraCount: number;
}

export interface AccentPhrase {
  /** Accent nucleus, 1-based; 0 = heiban. */
  accent: number;
  moraCount: number;
  moras: Mora[];
  words: AccentPhraseWord[];
  headNjdIndex: number;
  breathGroup: number;
  isQuestion: boolean;
}

export interface LabelResult {
  features: string[];
  accentPhrases: AccentPhrase[];
}

/** Numeric synthesis parameters passed straight through to hts_engine. */
export interface SynthParams {
  samplingFrequency?: number;
  framePeriod?: number;
  allPassConstant?: number;
  postfilter?: number;
  speechSpeedRate?: number;
  additionalHalfTone?: number;
  voicedUnvoicedThreshold?: number;
  gvWeightSpectrum?: number;
  gvWeightLogF0?: number;
  volume?: number;
}

export interface VoiceInfo {
  name: string;
  path: string;
}

export interface EnginePaths {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voices: VoiceInfo[];
}

export interface EngineConfig {
  openJtalk: string | null;
  htsEngine: string | null;
  dictionary: string | null;
  voice: string | null;
}

export interface PhonemeDuration {
  start: number;
  end: number;
  label: string;
}

/** One line of the script: text plus the accent edits applied to it. */
export interface Utterance {
  id: string;
  text: string;
  njd: NjdNode[];
  phrases: AccentPhrase[];
  params: SynthParams;
  voice: string | null;
}

export const DEFAULT_PARAMS: SynthParams = {
  speechSpeedRate: 1.0,
  additionalHalfTone: 0.0,
  allPassConstant: 0.55,
  postfilter: 0.0,
  voicedUnvoicedThreshold: 0.5,
  gvWeightSpectrum: 1.0,
  gvWeightLogF0: 1.0,
  volume: 0.0,
};
