/**
 * Chapter blocks → the sentence script the native speech engine plays (Kokoro on device, Apple fallback).
 *
 * Built on text prep (prep/prepare.ts: what is skipped, LitRPG system messages and stat tables, numbers and
 * abbreviations in words, the pronunciation dictionary), which runs v1's narration front-end
 * (vendor/v1/experiments/tts/frontend.ts, the PC narrator's) for sentences and pauses (sentence, paragraph,
 * dialogue turns, titles, scenes).
 *
 * One item per spoken sentence:
 *   text    plain text for the Apple voice and for Kokoro's own G2P (lexicon respellings applied),
 *   runs    only when the lexicon gave PHONEMES for a word in it: text runs + phoneme runs for Kokoro,
 *   block/start/end/hash  the sentence in the chapter's canonical blocks, so the reader can highlight it,
 *   paragraph  the reader paragraph it belongs to (v1 ChapterPosition.paragraph: progress + resume),
 *   pauseMs    silence after it at 1.0× (scene breaks are folded into the sentence before them).
 * Narrator mode (narrator.ts; native uses each only when its switch is on):
 *   role/parts dialogue in quotation marks: the whole sentence, or its quoted and narrated parts,
 *   speaker    1 on every other paragraph of an exchange (alternating dialogue voices),
 *   pacedMs    the smarter pause ("natural" preset), when it differs from pauseMs,
 *   relaxedMs  the same with the "relaxed" preset (the default), when it differs from pauseMs,
 *   rate       a deterministic ±3 % speed factor (prosody jitter),
 *   phrases    the sentence in phrases with a short pause after each (phrase breaks; not for sentences with
 *              lexicon phoneme runs, which can't be split by text).
 *
 * Pure ES2023: runs in the core (JSContext: lock-screen auto-continue) and in the UI (Listen from here).
 */
import { blockAnchor, renderPhonemeRuns, renderPlain, type Lexicon, type SourceBlock } from '@v1tts/frontend.ts';
import { alternateSpeakers, dialogueParts, pacedPause, phrases, rateJitter, type PacedSentence, type PhraseJson, type SpeechPartJson } from './narrator.ts';
import { prepareScript, type PrepareOptions } from './prep/prepare.ts';
import type { TextPrepPrefs } from './prep/prefs.ts';

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
  /** Narrator mode: the whole sentence is dialogue (absent: narration, or mixed — see `parts`). */
  role?: 'dialogue';
  /** Narrator mode: a sentence mixing quoted speech and narration, split by role. */
  parts?: SpeechPartJson[];
  /** Narrator mode: 1 = the other speaker of an exchange (absent: 0). */
  speaker?: 1;
  /** Narrator mode: the smarter pause (ms at 1.0×), when it differs from pauseMs. */
  pacedMs?: number;
  /** Narrator mode: the smarter pause with the "relaxed" preset (the default), when it differs from pauseMs. */
  relaxedMs?: number;
  /** Narrator mode: prosody jitter, a speed factor in [0.97, 1.03] (absent: 1). */
  rate?: number;
  /** Narrator mode: phrase breaks, when the sentence splits into more than one phrase. */
  phrases?: PhraseJson[];
}

export interface SpeechScript {
  frontendVersion: number;
  /** FNV-1a of the canonical block texts (frontend.ts NarrationScript.textHash). */
  textHash: string;
  items: SpeechItem[];
}

export interface SpeechScriptOptions extends PrepareOptions {
  /** Reader paragraph of a block (default: the block index). */
  paragraphOf?: (block: number) => number;
}

const SPEAKABLE = /[\p{L}\p{N}]/u;

export function speechScript(blocks: readonly SourceBlock[], opts: SpeechScriptOptions = {}): SpeechScript {
  const script = prepareScript(blocks, opts);
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
    if (seg.kind === 'text') {
      const display = blocks[seg.block]?.text.slice(seg.start, seg.end) ?? '';
      const parts = dialogueParts(display, seg.start, seg.pieces, seg.quoted);
      if (parts) item.parts = parts;
      else if (seg.quoted) item.role = 'dialogue';
      if (!item.runs) {
        const ph = phrases(text);
        if (ph.length > 1) item.phrases = ph;
      }
    }
    items.push(item);
  }
  const meta: PacedSentence[] = items.map((it) => ({
    block: it.block,
    kind: it.kind,
    text: it.text,
    pauseMs: it.pauseMs,
    dialogue: it.role === 'dialogue' || !!it.parts?.some((p) => p.role === 'dialogue'),
    quoted: it.role === 'dialogue',
  }));
  const speakers = alternateSpeakers(meta);
  items.forEach((it, i) => {
    const paced = pacedPause(meta, i);
    if (paced !== it.pauseMs) it.pacedMs = paced;
    const relaxed = pacedPause(meta, i, 'relaxed');
    if (relaxed !== it.pauseMs) it.relaxedMs = relaxed;
    if (speakers[i] === 1 && meta[i]?.dialogue) it.speaker = 1;
    const rate = rateJitter(it.hash);
    if (rate !== 1) it.rate = rate;
  });
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
  /** Text prep settings (Settings › Voices › Pronunciations › Reading); absent: the defaults. */
  prep?: TextPrepPrefs;
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
