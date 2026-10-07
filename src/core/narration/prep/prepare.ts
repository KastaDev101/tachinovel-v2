/**
 * Text prep: chapter blocks → the segments the speech engines say. Runs before the delivery stage (sentence
 * script, narrator mode, director) and hands it segments whose source offsets are exact, so highlighting and
 * "listen from here" keep working whatever was skipped or rewritten.
 *
 *   blocks ─cleanupPlan + system.ts─► plan (skip / separator / system / stat table / inline drops)
 *          ─maskBlock─► the same blocks with skipped text blanked out (same length: every offset stays valid)
 *          ─segmentChapter─► sentences, titles, scene breaks, pauses (v1's segmentation, sentences.ts)
 *          ─speak─► spoken pieces: pronunciation dictionary (lexicon.ts) + normalization (normalize.ts)
 *
 * Pure ES2023 (core and UI), deterministic: the UI (reader DOM) and the core (lock screen, Prepare for the
 * drive) build the same script from the same chapter and settings.
 */
import { DEFAULT_PAUSES, segmentHash, type FrontendOptions, type NarrationScript, type Piece, type Segment, type SourceBlock } from '@v1tts/frontend.ts';
import { cleanupPlan, type BlockPlan } from './cleanup.ts';
import { applyLexicon, compileLexicons, type CompiledLexicon } from './lexicon.ts';
import { normalizeSpeech, type NormalizeContext } from './normalize.ts';
import { DEFAULT_TEXT_PREP, type TextPrepPrefs } from './prefs.ts';
import { segmentChapter, type Speaker } from './sentences.ts';
import { entryText, findStatTables, isSystemBlock, parseStatLine, statSummary, type StatTable } from './system.ts';

export type TextPrepOptions = Partial<TextPrepPrefs>;

export interface PrepareOptions extends FrontendOptions, TextPrepOptions {}

export interface PreparedScript extends NarrationScript {
  /** Per block: what cleanup decided (tests, diagnostics). */
  plan: BlockPlan[];
  tables: StatTable[];
}

/** Pause between the lines of a stat table read in full (ms at 1.0×). */
export const TABLE_LINE_MS = 280;

/** The block with skipped text blanked out, same length (offsets stay valid); separators become "***". */
export function maskBlock(text: string, plan: BlockPlan): string {
  if (plan.skip) return ' '.repeat(text.length);
  if (plan.separator) return '*'.repeat(Math.max(1, text.length));
  let out = text;
  for (const d of plan.drops ?? []) out = out.slice(0, d.start) + ' '.repeat(d.end - d.start) + out.slice(d.end);
  return out;
}

const isOverride = (p: Piece): boolean => p.say !== undefined || p.ipa !== undefined;

/** Stand-ins for dictionary words while a sentence is normalized: private-use characters no rule touches. */
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);
const MARK_BASE = 0xe100;
const MARK_MAX = 0xf8ff - MARK_BASE;
const MARK = new RegExp(`${MARK_OPEN}([${String.fromCharCode(MARK_BASE)}-${String.fromCharCode(0xf8ff)}])${MARK_CLOSE}`, 'u');
const mark = (i: number): string => MARK_OPEN + String.fromCharCode(MARK_BASE + i) + MARK_CLOSE;

/**
 * Spoken pieces of a sentence: dictionary words cut out first (they win over every rule), the sentence
 * normalized once with the words standing in as marks (rules see their context), then the dictionary once
 * more over words normalization produced ("Lv." → "Level").
 */
export function speak(display: string, lex: CompiledLexicon, ctx: NormalizeContext = {}): Piece[] {
  const raw = display.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const pieces = applyLexicon(raw, lex);
  const overrides = pieces.filter(isOverride);
  let out: Piece[] | null = null;
  if (overrides.length === 0) {
    out = [{ text: normalizeSpeech(raw, ctx) }];
  } else if (overrides.length <= MARK_MAX) {
    let k = 0;
    const parts = normalizeSpeech(pieces.map((p) => (isOverride(p) ? mark(k++) : p.text)).join(''), ctx).split(MARK);
    // split() with a capture group: text, mark, text, mark…; every mark must have survived, in order.
    const marks = parts.filter((_, i) => i % 2 === 1).map((m) => m.charCodeAt(0) - MARK_BASE);
    if (marks.length === overrides.length && marks.every((m, i) => m === i)) {
      out = parts.flatMap((part, i): Piece[] => (i % 2 === 1 ? [overrides[part.charCodeAt(0) - MARK_BASE] as Piece] : part ? [{ text: part }] : []));
    }
  }
  // A mark lost to a rule (not seen so far): normalize around the dictionary words instead.
  out ??= pieces.map((p) => (isOverride(p) ? p : { text: normalizeSpeech(p.text, ctx) }));
  return out.flatMap((p) => (isOverride(p) ? [p] : applyLexicon(p.text, lex)));
}

/** The chapter's plan: cleanup, stat tables (by mode), system messages. */
export function planChapter(blocks: readonly SourceBlock[], opts: PrepareOptions = {}): { plan: BlockPlan[]; tables: StatTable[] } {
  const prefs = { ...DEFAULT_TEXT_PREP, ...opts };
  const plan = cleanupPlan(blocks, { ...(opts.title ? { title: opts.title } : {}), skipNotes: prefs.skipNotes });
  const tables = findStatTables(blocks, plan);
  tables.forEach((t, ti) =>
    t.blocks.forEach((bi, k) => {
      const p = plan[bi] as BlockPlan;
      p.table = ti;
      p.system = true;
      if (prefs.statTables === 'skip' || (prefs.statTables === 'short' && k > 0)) p.skip = 'stat-table';
    }),
  );
  blocks.forEach((b, bi) => {
    const p = plan[bi] as BlockPlan;
    if (!p.skip && !p.separator && p.table === undefined && isSystemBlock(maskBlock(b.text, p))) p.system = true;
  });
  return { plan, tables };
}

/** The chapter's narration script (v1 NarrationScript shape: the sentence script builds on it unchanged). */
export function prepareScript(blocks: readonly SourceBlock[], opts: PrepareOptions = {}): PreparedScript {
  const prefs = { ...DEFAULT_TEXT_PREP, ...opts };
  const { plan, tables } = planChapter(blocks, opts);
  const masked: SourceBlock[] = blocks.map((b, i) => {
    const text = maskBlock(b.text, plan[i] ?? {});
    return b.cls ? { text, tag: b.tag, cls: b.cls } : { text, tag: b.tag };
  });
  const { lexicons, ...frontend } = opts;
  const lex = compileLexicons(lexicons ?? []);
  const stutter = opts.stutter ?? 'drop';
  const summarized = new Set<number>();
  /** First block of a stat table read as a summary → the summary was said. */
  const summaryBlocks = new Set<number>();

  const speaker: Speaker = (req) => {
    const p = plan[req.block] ?? {};
    const ctx: NormalizeContext = { system: req.kind !== 'title' && p.system === true, stutter };
    if (req.kind !== 'title' && p.table !== undefined) {
      if (prefs.statTables === 'short') {
        // The whole table as one short summary, said with its first sentence; its other lines say nothing.
        if (summarized.has(p.table)) return [];
        summarized.add(p.table);
        summaryBlocks.add(req.block);
        return speak(statSummary(tables[p.table] as StatTable), lex, ctx);
      }
      const entry = parseStatLine(req.display);
      return speak(entry ? entryText(entry) : req.display, lex, ctx);
    }
    return speak(req.display, lex, ctx);
  };
  const script = segmentChapter(masked, { ...frontend, readNotes: !prefs.skipNotes }, speaker);

  const pauses = { ...DEFAULT_PAUSES, ...opts.pauses };
  const segments: Segment[] = script.segments.map((seg) => {
    if (seg.kind === 'scene') return seg;
    const p = plan[seg.block] ?? {};
    const out: Segment = { ...seg, kind: seg.kind === 'title' ? 'title' : p.system ? 'system' : 'text' };
    // The summary covers its whole first block, so highlighting shows where the table is.
    if (out.kind !== 'title' && summaryBlocks.has(seg.block)) {
      out.start = 0;
      out.end = blocks[seg.block]?.text.length ?? seg.end;
    }
    // From the reader's text (not the masked one): a sentence keeps its hash whatever was left out around it.
    if (out.start !== out.end) out.hash = segmentHash((blocks[seg.block]?.text ?? '').slice(out.start, out.end));
    return out;
  });

  // Pauses after the last sentence of a block follow its kind (system messages get room before and after);
  // the lines of a stat table read in full follow each other closely.
  segments.forEach((a, i) => {
    const b = segments[i + 1];
    if (a.kind === 'scene' || a.kind === 'title') return;
    const table = plan[a.block]?.table;
    if (table !== undefined && prefs.statTables === 'full' && b && b.kind !== 'scene' && plan[b.block]?.table === table) {
      a.pauseAfterMs = TABLE_LINE_MS;
      return;
    }
    if (b && b.block === a.block) return;
    if (b?.kind === 'scene') a.pauseAfterMs = 0;
    else a.pauseAfterMs = Math.max(a.kind === 'system' ? pauses.system : pauses.paragraph, b?.kind === 'system' && a.kind !== 'system' ? pauses.system : 0);
  });

  return { ...script, segments, plan, tables };
}
