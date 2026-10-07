/**
 * The handover between text prep and the delivery stage (sentence script, narrator mode, director, audio): what
 * to say, how, and where it is in the chapter. The same shape as the text-cleanup branch's type (narration-text),
 * so whichever lands second keeps this file's contract; natural delivery only reads `kind`: 'system' (a LitRPG
 * system message or status window) gets a crisp, slightly faster, even read, everything else is 'normal'.
 * No imports on purpose (delivery.ts and the Voice Lab fixtures run in plain Node).
 */
export interface NarrationSegment {
  /** What to say: cleaned, numbers and abbreviations in words, pronunciation respellings applied. */
  text: string;
  /** 'system': a LitRPG system message or status window; everything else is 'normal' (titles included). */
  kind: 'normal' | 'system';
  /** Where it is: the block, and [start, end) in that block's canonical text (highlighting, listen from here). */
  block: number;
  start: number;
  end: number;
}

/** The front-end's sentence kinds (speech-script.ts SpeechItem.kind) as a segment kind. */
export function segmentKind(kind: 'title' | 'text' | 'system'): NarrationSegment['kind'] {
  return kind === 'system' ? 'system' : 'normal';
}
