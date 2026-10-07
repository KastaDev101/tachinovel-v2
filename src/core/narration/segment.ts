/**
 * The handover between text prep (src/core/narration/prep) and the delivery stage (sentence script, narrator
 * mode, director, audio): what to say, how, and where it is in the chapter. Skipped text (notes, plugs,
 * navigation, anti-theft lines, repeated titles, stat tables per the setting) never appears here.
 */
import { renderPlain, type NarrationScript, type SourceBlock } from '@v1tts/frontend.ts';
import { prepareScript, type PrepareOptions } from './prep/prepare.ts';

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

/** A prepared script's segments as NarrationSegments (scene breaks are pauses, not segments). */
export function toNarrationSegments(script: NarrationScript): NarrationSegment[] {
  return script.segments
    .filter((s) => s.kind !== 'scene')
    .map((s) => ({ text: renderPlain(s.pieces), kind: s.kind === 'system' ? 'system' : 'normal', block: s.block, start: s.start, end: s.end }));
}

/** Text prep for a chapter's blocks, as NarrationSegments. */
export function narrationSegments(blocks: readonly SourceBlock[], opts: PrepareOptions = {}): NarrationSegment[] {
  return toNarrationSegments(prepareScript(blocks, opts));
}
