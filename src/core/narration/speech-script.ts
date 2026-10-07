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
 * Narrator mode (narrator.ts; native uses each only when its switch is on):
 *   role/parts dialogue in quotation marks: the whole sentence, or its quoted and narrated parts,
 *   speaker    1 on every other paragraph of an exchange (alternating dialogue voices),
 *   pacedMs    the smarter pause ("natural" preset), when it differs from pauseMs,
 *   relaxedMs  the same with the "relaxed" preset (the default), when it differs from pauseMs,
 *   rate       a deterministic ±3 % speed factor (prosody jitter),
 *   phrases    the sentence in phrases with a short pause after each (phrase breaks; not for sentences with
 *              lexicon phoneme runs, which can't be split by text).
 * Natural delivery (delivery.ts; native uses these only for the expressive narrator, Chatterbox Nano, which reads
 * whole sentences instead of phrases):
 *   mood       the director's label (absent: calm), from dialogue tags, punctuation, emphasis and the scene,
 *   line       the line class when it isn't plain narration/dialogue (teasing, commanding, tender),
 *   delivery   Nano's controls for the sentence: temperature, gain, tempo, pitch (cents), a pause before it, the
 *              [whispering] lead, and `say`, the text Nano reads when it differs (a sound tag, reshaped capitals,
 *              a falling ending, a pause before the key word); the displayed text and its offsets never change,
 *   naturalMs  the natural pause after it (relaxed pacing ±15 %, ×1.2 after "…", a command's room to land), when it differs
 *              from relaxedMs/pauseMs,
 *   breath     a natural place for a breath after it (a paragraph start, a long sentence-final pause; never inside
 *              a quotation that goes on, never in a back-and-forth).
 * The script carries `delivery` (DELIVERY_HEADER: the mood table and the audio tunables) once.
 *
 * Pure ES2023: runs in the core (JSContext: lock-screen auto-continue) and in the UI (Listen from here).
 */
import { blockAnchor, buildScript, renderPhonemeRuns, renderPlain, type FrontendOptions, type Lexicon, type SourceBlock } from '@v1tts/frontend.ts';
import {
  alternateSpeakers,
  dialogueParts,
  pacedPause,
  phrases,
  quotedShare,
  rateJitter,
  singleQuoteSpans,
  singleQuoteStyle,
  type PacedSentence,
  type PhraseJson,
  type SpeechPartJson,
} from './narrator.ts';
import {
  DELIVERY_HEADER,
  deliveryParams,
  direct,
  nanoText,
  naturalPause,
  pauseAfter,
  pauseContext,
  breathPoint,
  pauseSeed,
  planChunks,
  POV_HEADER,
  speechShape,
  type BreathPoint,
  type DeliveryHeader,
  type DeliveryJson,
  type DirectorSentence,
  type Emphasis,
  type LineClass,
  type Mood,
  type PauseSide,
} from './delivery.ts';

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
  /** A character's thought ('…' in a chapter that quotes speech with “…”): read like dialogue, a little closer. */
  thought?: true;
  /** Natural delivery: which read of the narrator voice says it (absent: the calm Narrator). "performed" for
   * dialogue and thoughts; "tense", "sad", "tender" for a mood (moodVoices); one model call never mixes two. */
  voice?: NarratorVoice;
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
  /** Natural delivery: the director's mood (absent: calm). */
  mood?: Mood;
  /** Natural delivery: teasing / commanding / tender (absent: plain narration or dialogue). */
  line?: Exclude<LineClass, 'narration' | 'dialogue'>;
  /** Natural delivery: Nano's controls for this sentence. */
  delivery?: DeliveryJson;
  /** Natural delivery: the pause after it (ms at 1.0×), when it differs from relaxedMs (or pauseMs). */
  naturalMs?: number;
  /** Natural delivery: a breath may go in the pause after it (native's lung budget decides; never adds time). */
  breath?: BreathPoint;
  /** Natural delivery: the breath-group chunk (one Nano call) the sentence belongs to; consecutive ids. */
  chunk?: number;
}

export interface SpeechScript {
  frontendVersion: number;
  /** FNV-1a of the canonical block texts (frontend.ts NarrationScript.textHash). */
  textHash: string;
  items: SpeechItem[];
  /** Natural delivery: the mood table and audio tunables native applies (delivery.ts). */
  delivery?: DeliveryHeader;
}

export interface SpeechScriptOptions extends FrontendOptions {
  /** Reader paragraph of a block (default: the block index). */
  paragraphOf?: (block: number) => number;
  /** Italic and bold text of the chapter, in document order (natural delivery's emphasis). */
  emphasis?: readonly Emphasis[];
}

/** The front-end's scene-break pause (frontend.ts DEFAULT_PAUSES.scene): a new scene starts after it. */
const SCENE_MS = 1800;

export type NarratorVoice = 'performed' | 'tense' | 'sad' | 'tender';

/** Narration takes a mood's voice only when the mood holds this many sentences in a row (a single tense sentence
 * stays in the calm voice: the director's tempo and gain carry it). */
export const MOOD_VOICE_RUN = 2;

/**
 * The read of the narrator voice per sentence (undefined = the calm Narrator). Dialogue and thoughts: performed,
 * or the mood's voice (tense/intense → tense, sad → sad, soft/whisper → tender). Narration: tense or sad only, and
 * only through a run of MOOD_VOICE_RUN sentences in that mood; system messages and titles stay calm.
 */
export function moodVoices(list: readonly { kind: string; mood: Mood; performed: boolean }[]): (NarratorVoice | undefined)[] {
  const moodVoice = (m: Mood): NarratorVoice | undefined =>
    m === 'tense' || m === 'intense' ? 'tense' : m === 'sad' ? 'sad' : m === 'soft' || m === 'whisper' ? 'tender' : undefined;
  const narrationMood = (i: number): NarratorVoice | undefined => {
    const s = list[i];
    if (!s || s.kind !== 'text' || s.performed) return undefined;
    const v = moodVoice(s.mood);
    return v === 'tense' || v === 'sad' ? v : undefined;
  };
  return list.map((s, i) => {
    if (s.kind !== 'text') return undefined;
    if (s.performed) return moodVoice(s.mood) ?? 'performed';
    const v = narrationMood(i);
    if (!v) return undefined;
    // The run of narration in this mood around i (dialogue in between breaks it).
    let run = 1;
    for (let j = i - 1; j >= 0 && narrationMood(j) === v; j--) run++;
    for (let j = i + 1; j < list.length && narrationMood(j) === v; j++) run++;
    return run >= MOOD_VOICE_RUN ? v : undefined;
  });
}

/** A sentence at least this much dialogue is performed rather than narrated (“Run,” she said. → performed). */
const PERFORMED_SHARE = 0.5;
/** How much quieter a thought is than speech, dB. */
const THOUGHT_GAIN_DB = 1.5;

/** Letters of a sentence's dialogue parts (0…1); 1 for a sentence that is all dialogue. */
function dialogueShare(it: SpeechItem): number {
  if (it.role === 'dialogue') return 1;
  if (!it.parts) return 0;
  const letters = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
  const total = it.parts.reduce((n, p) => n + letters(p.text), 0);
  const inside = it.parts.reduce((n, p) => n + (p.role === 'dialogue' ? letters(p.text) : 0), 0);
  return total > 0 ? inside / total : 0;
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
  singleQuotes(blocks, items);
  const meta: PacedSentence[] = items.map((it) => ({
    block: it.block,
    kind: it.kind,
    text: it.text,
    pauseMs: it.pauseMs,
    dialogue: it.role === 'dialogue' || !!it.parts?.some((p) => p.role === 'dialogue'),
    quoted: it.role === 'dialogue',
  }));
  const speakers = alternateSpeakers(meta);
  naturalDelivery(blocks, items, meta, opts.emphasis);
  items.forEach((it, i) => {
    if (speakers[i] === 1 && meta[i]?.dialogue) it.speaker = 1;
    const rate = rateJitter(it.hash);
    if (rate !== 1) it.rate = rate;
  });
  return { frontendVersion: script.frontendVersion, textHash: script.textHash, items, delivery: DELIVERY_HEADER };
}

/** A sentence this much inside single quotation marks is a thought; in a chapter quoting speech with them (where
 * the front-end doesn't split “‘Run,’ she said. ‘Now.’” at the quote), half of it makes it speech. Splitting such
 * a sentence into parts like dialogueParts does is a later step. */
const SINGLE_QUOTED_SHARE = { thought: 0.6, dialogue: 0.5 } as const;

function singleQuotes(blocks: readonly SourceBlock[], items: SpeechItem[]): void {
  const texts = blocks.map((b) => b.text);
  if (!texts.some((t) => /['‘]/u.test(t))) return;
  const spans = singleQuoteSpans(texts);
  const style = singleQuoteStyle(texts);
  for (const it of items) {
    if (it.kind !== 'text' || it.role || it.parts) continue;
    const s = spans[it.block];
    if (!s?.length || quotedShare(texts[it.block] ?? '', it.start, it.end, s) < SINGLE_QUOTED_SHARE[style]) continue;
    it.role = 'dialogue';
    if (style === 'thought') it.thought = true;
  }
}

/**
 * Natural delivery (delivery.ts) over the script: the director's cues, Nano's parameters and text, the context
 * pauses, breath points and breath-group chunks. Fills in relaxedMs/pacedMs too (the pause model's fallback).
 */
function naturalDelivery(blocks: readonly SourceBlock[], items: SpeechItem[], meta: readonly PacedSentence[], emphasis: readonly Emphasis[] | undefined): void {
  const displays = items.map((it) => blocks[it.block]?.text.slice(it.start, it.end) ?? it.text);
  const directed: DirectorSentence[] = items.map((it, i) => {
    const prev = items[i - 1];
    // A new scene: after a scene break, at a POV header, after two or more blank paragraphs.
    const blank = prev ? blocks.slice(prev.block + 1, it.block).filter((b) => b.tag !== 'hr' && !b.text.trim()).length : 0;
    const display = displays[i] ?? it.text;
    return {
      block: it.block,
      kind: it.kind,
      display,
      narration: it.parts ? it.parts.filter((p) => p.role === 'narration').map((p) => p.text).join(' ') : it.role === 'dialogue' ? '' : it.text,
      speech: it.parts ? it.parts.filter((p) => p.role === 'dialogue').map((p) => p.text).join(' ') : it.role === 'dialogue' ? it.text : '',
      dialogueShare: dialogueShare(it),
      ...(it.thought ? { thought: true } : {}),
      sceneStart: !!prev && (prev.pauseMs >= SCENE_MS || blank >= 2 || (display.length <= 60 && POV_HEADER.test(display.trim()))),
    };
  });
  const cues = direct(directed, emphasis ? { emphasis } : {});
  // Each sentence as the pause model and the chunker see it: does it start/end spoken, is a quotation still open
  // at its end (the speaker goes on in the next paragraph), is it a one-word command.
  let open = false;
  const sides: PauseSide[] = items.map((it, i) => {
    if (i > 0 && items[i - 1]?.block !== it.block) open = false;
    for (const ch of displays[i] ?? '') {
      if (ch === '“' || ch === '«' || ch === '「') open = true;
      else if (ch === '”' || ch === '»' || ch === '」') open = false;
      else if (ch === '"') open = !open;
    }
    const first = it.parts?.[0]?.role;
    const last = it.parts?.[it.parts.length - 1]?.role;
    const words = (directed[i]?.speech ?? '').match(/\p{L}[\p{L}'’]*/gu) ?? [];
    return {
      block: it.block,
      kind: it.kind,
      startsSpoken: it.role === 'dialogue' || first === 'dialogue',
      endsSpoken: it.role === 'dialogue' || last === 'dialogue',
      quoteOpen: open,
      command: cues[i]?.line === 'commanding' && words.length <= 2,
    };
  });
  items.forEach((it, i) => {
    const paced = pacedPause(meta, i);
    if (paced !== it.pauseMs) it.pacedMs = paced;
    const relaxed = pacedPause(meta, i, 'relaxed');
    if (relaxed !== it.pauseMs) it.relaxedMs = relaxed;
    const cue = cues[i];
    if (cue) {
      if (cue.mood !== 'calm') it.mood = cue.mood;
      if (cue.line && cue.line !== 'narration' && cue.line !== 'dialogue') it.line = cue.line;
      const say = nanoText(it.text, cue);
      it.delivery = { ...deliveryParams(cue), ...(say !== it.text ? { say } : {}), ...speechShape(say) };
    }
    const side = sides[i];
    const context = side ? pauseContext(side, sides[i + 1], it.pauseMs >= SCENE_MS) : undefined;
    const natural =
      naturalPause({
        kind: it.kind,
        display: displays[i] ?? it.text,
        pauseMs: it.pauseMs,
        relaxedMs: relaxed,
        sameParagraphNext: items[i + 1]?.block === it.block,
        ...(context ? { context } : {}),
        intense: cue?.mood === 'intense',
        seed: pauseSeed(it.hash, it.id),
      }) + (cue && context !== 'command' ? pauseAfter(cue) : 0);
    if (natural !== relaxed) it.naturalMs = natural;
    const next = items[i + 1];
    const breath = breathPoint(
      { block: it.block, kind: it.kind, speaks: (directed[i]?.dialogueShare ?? 0) > 0 },
      next
        ? {
            block: next.block,
            kind: next.kind,
            speaks: (directed[i + 1]?.dialogueShare ?? 0) > 0,
            continuesQuote: next.block === it.block && !!sides[i + 1]?.startsSpoken && !/^["“«「『]/u.test((displays[i + 1] ?? '').trim()),
          }
        : undefined,
      natural,
    );
    if (breath) it.breath = breath;
  });
  const voices = moodVoices(
    items.map((it) => ({ kind: it.kind, mood: it.mood ?? 'calm', performed: it.kind === 'text' && (!!it.thought || dialogueShare(it) >= PERFORMED_SHARE) })),
  );
  items.forEach((it, i) => {
    const v = voices[i];
    if (v) it.voice = v;
    // A thought sits a little closer and quieter than speech.
    if (it.thought && it.delivery) it.delivery.g = Math.round((it.delivery.g - THOUGHT_GAIN_DB) * 10) / 10;
  });
  const chunks = planChunks(
    items.map((it, i) => ({
      voice: it.voice ?? 'narrator',
      block: it.block,
      kind: it.kind,
      chars: (it.delivery?.say ?? it.text).length,
      startsSpoken: sides[i]?.startsSpoken ?? false,
      quoteOpen: sides[i]?.quoteOpen ?? false,
      ...(it.delivery ? { t: it.delivery.t } : {}),
    })),
  );
  items.forEach((it, i) => {
    it.chunk = chunks[i] ?? i;
  });
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
