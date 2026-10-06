/**
 * Chapter blocks → the sentence script the native speech engine plays (Kokoro on device, Apple fallback).
 *
 * Built on v1's narration front-end (vendor/v1/experiments/tts/frontend.ts, the same code the PC narrator
 * uses), so the narrator's fixes apply on the phone too: text normalization ("Ch. 12" → "Chapter 12",
 * numbers, units, shouting, stutters…), the pronunciation lexicon (built-in interjections + the user's
 * global and per-novel entries) and the pauses (sentence, paragraph, dialogue turns, titles, scenes).
 *
 * One item per spoken sentence:
 *   text    plain text for the Apple voice and for Kokoro's own G2P (lexicon respellings applied),
 *   runs    only when the lexicon gave PHONEMES for a word in it: text runs + phoneme runs for Kokoro,
 *   block/start/end/hash  the sentence in the chapter's canonical blocks, so the reader can highlight it,
 *   paragraph  the reader paragraph it belongs to (v1 ChapterPosition.paragraph: progress + resume),
 *   pauseMs    silence after it at 1.0× (scene breaks are folded into the sentence before them).
 *
 * Pure ES2023: runs in the core (JSContext: lock-screen auto-continue) and in the UI (Listen from here).
 */
import { blockAnchor, buildScript, renderPhonemeRuns, renderPlain, type FrontendOptions, type Lexicon, type SourceBlock } from '@v1tts/frontend.ts';

export interface SpeechRunJson {
  /** Text for the engine's G2P. */
  t?: string;
  /** Kokoro (misaki) phonemes from the lexicon. */
  p?: string;
}

export interface SpeechItem {
  /** Front-end segment id (stable for the same text and options). */
  id: number;
  block: number;
  paragraph: number;
  start: number;
  end: number;
  hash: number;
  kind: 'title' | 'text' | 'system';
  text: string;
  runs?: SpeechRunJson[];
  pauseMs: number;
}

export interface SpeechScript {
  frontendVersion: number;
  /** FNV-1a of the canonical block texts (frontend.ts NarrationScript.textHash). */
  textHash: string;
  items: SpeechItem[];
}

export interface SpeechScriptOptions extends FrontendOptions {
  /** Reader paragraph of a block (default: the block index). */
  paragraphOf?: (block: number) => number;
}

const SPEAKABLE = /[\p{L}\p{N}]/u;

export function speechScript(blocks: readonly SourceBlock[], opts: SpeechScriptOptions = {}): SpeechScript {
  const script = buildScript(blocks, opts);
  const items: SpeechItem[] = [];
  for (const seg of script.segments) {
    if (seg.kind === 'scene') {
      // The front-end gives the scene segment the silence (and zeroes the pause before it).
      const prev = items[items.length - 1];
      if (prev) prev.pauseMs = Math.max(prev.pauseMs, seg.pauseAfterMs);
      continue;
    }
    const text = renderPlain(seg.pieces);
    if (!SPEAKABLE.test(text)) continue;
    const item: SpeechItem = {
      id: seg.id,
      block: seg.block,
      paragraph: opts.paragraphOf ? opts.paragraphOf(seg.block) : seg.block,
      start: seg.start,
      end: seg.end,
      hash: seg.hash,
      kind: seg.kind,
      text,
      pauseMs: seg.pauseAfterMs,
    };
    if (seg.pieces.some((p) => p.ipa)) {
      item.runs = renderPhonemeRuns(seg.pieces).map((r) => (r.phonemes !== undefined ? { p: r.phonemes } : { t: r.text ?? '' }));
    }
    items.push(item);
  }
  return { frontendVersion: script.frontendVersion, textHash: script.textHash, items };
}

/**
 * Map front-end blocks to reader paragraphs by text (the core has no DOM): each block goes to the first
 * paragraph at or after the previous match whose anchor matches, else stays with the previous one.
 */
export function paragraphMapper(blocks: readonly SourceBlock[], paragraphs: readonly string[]): (block: number) => number {
  const anchors = paragraphs.map((p) => blockAnchor(p));
  const map: number[] = [];
  let at = 0;
  blocks.forEach((b, i) => {
    const a = blockAnchor(b.text);
    if (a) {
      for (let k = at; k < Math.min(anchors.length, at + 12); k++) {
        const pa = anchors[k] ?? '';
        if (pa && (pa.startsWith(a.slice(0, 20)) || a.startsWith(pa.slice(0, 20)))) {
          at = k;
          break;
        }
      }
    }
    map[i] = at;
  });
  return (block) => map[block] ?? block;
}

// ---------------------------------------------------------------- pronunciation lexicons (storage shape)

/** Stored in the synced store (narration/lexicons.json); edited in Settings › Voices › Pronunciations. */
export interface LexiconStore {
  schemaVersion: 1;
  global: Lexicon;
  /** novel key "<pluginId>:<novelPath>" → that novel's entries. */
  novels: Record<string, Lexicon>;
}

export const EMPTY_LEXICON: Lexicon = { schemaVersion: 1, entries: [] };

export function emptyLexiconStore(): LexiconStore {
  return { schemaVersion: 1, global: { schemaVersion: 1, entries: [] }, novels: {} };
}

/** Lexicons for a novel, lowest priority first (the front-end adds its built-in list below them). */
export function lexiconsFor(store: LexiconStore, novelKey: string | undefined): Lexicon[] {
  const out: Lexicon[] = [store.global];
  const novel = novelKey ? store.novels[novelKey] : undefined;
  if (novel) out.push(novel);
  return out;
}
