/**
 * Narration manifest: the timestamp file written next to every narrated chapter audio file.
 *
 *   <chapter>.<voice>.m4a   AAC-LC mono 24 kHz, -16 LUFS
 *   <chapter>.<voice>.json  this manifest (~5–10 KB for a 2,000-word chapter)
 *
 * Segments are compact tuples so a long chapter stays small enough to pass over the bridge in one
 * message. Offsets refer to the canonical block text (frontend.ts `canonicalize`), so the reader can
 * highlight the sentence being spoken in its own DOM. If the reader's text differs from the text the
 * PC narrated (title line inserted, cleanup rules, edited chapter), `alignSegments` re-maps segments
 * by their text hashes.
 *
 * Portable: ES2023 only.
 */
import { buildScript, type FrontendOptions, type NarrationScript, type SourceBlock } from './frontend.ts';

export const MANIFEST_SCHEMA = 1;

/** [segmentId, block, start, end, t0Ms, t1Ms, hash24, kindCode]. kindCode: 0 text, 1 title, 2 system, 3 scene, +4 if quoted. */
export type SegmentTuple = [number, number, number, number, number, number, number, number];

export interface NarrationManifest {
  schemaVersion: typeof MANIFEST_SCHEMA;
  kind: 'tachinovel.narration';
  createdAt: string;
  engine: {
    name: string; // 'kokoro-82m-v1.0'
    runtime: string; // 'onnxruntime-gpu 1.30 cuda' | 'kokoro-js wasm' | 'openai gpt-4o-mini-tts' …
    voice: string;
    speed: number;
    frontendVersion: number;
    lexiconHash?: string;
  };
  chapter: {
    pluginId: string;
    novelPath: string;
    chapterPath: string;
    title: string;
    number?: number;
    /** Next chapter (for auto-advance before the chapter list is loaded). */
    next?: { chapterPath: string; title: string };
  };
  audio: {
    file: string;
    /**
     * Where this chapter starts inside `file`, when the file is a multi-chapter bundle (.m4b).
     * Absent or 0 for one file per chapter. Segment times and `durationMs` are relative to the
     * chapter, so a bundle's manifests look like single-chapter ones plus this offset.
     */
    offsetMs?: number;
    /** Length of this chapter (not of the whole bundle). */
    durationMs: number;
    codec: 'aac' | 'mp3' | 'opus' | 'wav';
    sampleRate: number;
    bytes: number;
    lufs?: number;
  };
  /** Of the canonical block texts joined by "\n\n" (frontend.ts NarrationScript.textHash). */
  textHash: string;
  blockCount: number;
  segments: SegmentTuple[];
}

export interface TimedSegment {
  id: number;
  block: number;
  start: number;
  end: number;
  t0: number;
  t1: number;
  hash: number;
  kind: 'text' | 'title' | 'system' | 'scene';
  quoted: boolean;
}

const KIND_CODES = ['text', 'title', 'system', 'scene'] as const;

export function kindCode(kind: TimedSegment['kind'], quoted: boolean): number {
  return KIND_CODES.indexOf(kind) + (quoted ? 4 : 0);
}

export function decodeSegments(m: Pick<NarrationManifest, 'segments'>): TimedSegment[] {
  return m.segments.map(([id, block, start, end, t0, t1, hash, code]) => ({
    id,
    block,
    start,
    end,
    t0,
    t1,
    hash,
    kind: KIND_CODES[code & 3] ?? 'text',
    quoted: (code & 4) !== 0,
  }));
}

/** Build the tuple list from a script and per-segment [t0, t1] in ms (index = segment id). */
export function encodeSegments(script: NarrationScript, times: readonly (readonly [number, number])[]): SegmentTuple[] {
  return script.segments.map((s) => {
    const t = times[s.id] ?? [0, 0];
    return [s.id, s.block, s.start, s.end, Math.round(t[0]), Math.round(t[1]), s.hash, kindCode(s.kind, s.quoted)];
  });
}

/** Chapter start inside the audio file (0 unless the file is a bundle). */
export function audioOffsetMs(m: Pick<NarrationManifest, 'audio'>): number {
  const o = m.audio.offsetMs;
  return typeof o === 'number' && o > 0 ? o : 0;
}

/** Audio-file time (ms) → chapter time (ms). */
export function chapterMs(m: Pick<NarrationManifest, 'audio'>, fileMs: number): number {
  return fileMs - audioOffsetMs(m);
}

/** Chapter time (ms) → audio-file time (ms), e.g. to seek a bundle to a sentence. */
export function fileMs(m: Pick<NarrationManifest, 'audio'>, chapterTimeMs: number): number {
  return chapterTimeMs + audioOffsetMs(m);
}

/** The chapter is over: its last sample in the file has played (bundles don't fire `ended` per chapter). */
export function chapterEnded(m: Pick<NarrationManifest, 'audio'>, fileTimeMs: number): boolean {
  return chapterMs(m, fileTimeMs) >= m.audio.durationMs;
}

/**
 * Index of the segment playing at `ms` (the last one starting at or before it), or -1 before the
 * first. Pauses belong to the segment before them, so the highlight doesn't flicker off between
 * sentences. Binary search: called on every `timeupdate`.
 */
export function segmentIndexAt(segs: readonly TimedSegment[], ms: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (s && s.t0 <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** First segment at or after a reading position (block, char offset): "start reading from here". */
export function segmentIndexForPosition(segs: readonly TimedSegment[], block: number, offset = 0): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s) continue;
    if (s.block > block || (s.block === block && s.end > offset)) return i;
  }
  return segs.length - 1;
}

export interface Alignment {
  /** 'exact' when the reader's text hash matches the manifest; 'hash' when re-mapped; 'none' if too little matched. */
  mode: 'exact' | 'hash' | 'none';
  /** Segments with block/start/end in the READER's text (unmatched segments are dropped). */
  segments: TimedSegment[];
  matched: number;
  total: number;
}

/**
 * Map manifest segments onto the reader's blocks. Fast path: identical text hash → as is. Otherwise
 * run the same front-end over the reader's blocks and match segments by hash, in order (an LCS-style
 * greedy walk), carrying the timing over. Highlighting then works even if the reader shows an inserted
 * title line, or a cleanup rule removed an ad paragraph.
 */
export function alignSegments(m: NarrationManifest, readerBlocks: readonly SourceBlock[], opts: FrontendOptions = {}): Alignment {
  const segs = decodeSegments(m);
  const script = buildScript(readerBlocks, opts);
  if (script.textHash === m.textHash) return { mode: 'exact', segments: segs, matched: segs.length, total: segs.length };
  const local = script.segments;
  const out: TimedSegment[] = [];
  let j = 0;
  for (const s of segs) {
    if (s.kind === 'scene') continue;
    // Look ahead a bounded window for the same hash.
    let found = -1;
    for (let k = j; k < Math.min(local.length, j + 40); k++) {
      if (local[k]?.hash === s.hash) {
        found = k;
        break;
      }
    }
    if (found < 0) continue;
    const l = local[found];
    if (!l) continue;
    out.push({ ...s, block: l.block, start: l.start, end: l.end });
    j = found + 1;
  }
  const total = segs.filter((s) => s.kind !== 'scene').length;
  return { mode: out.length >= total * 0.5 ? 'hash' : 'none', segments: out, matched: out.length, total };
}

export function validateManifest(x: unknown): string[] {
  const errs: string[] = [];
  const m = x as Partial<NarrationManifest> | null;
  if (typeof m !== 'object' || m === null) return ['not an object'];
  if (m.kind !== 'tachinovel.narration') errs.push('kind');
  if (m.schemaVersion !== MANIFEST_SCHEMA) errs.push('schemaVersion');
  if (!m.audio || typeof m.audio.file !== 'string' || !(m.audio.durationMs > 0)) errs.push('audio');
  else if (m.audio.offsetMs !== undefined && !(typeof m.audio.offsetMs === 'number' && m.audio.offsetMs >= 0)) errs.push('audio.offsetMs');
  if (!Array.isArray(m.segments)) return [...errs, 'segments'];
  let lastT = -1;
  m.segments.forEach((t, i) => {
    if (!Array.isArray(t) || t.length !== 8 || t.some((v) => typeof v !== 'number')) return void errs.push(`segments[${i}] shape`);
    if (t[4] < lastT) errs.push(`segments[${i}] not sorted by time`);
    if (t[5] < t[4]) errs.push(`segments[${i}] ends before it starts`);
    if (t[3] < t[2]) errs.push(`segments[${i}] bad range`);
    lastT = t[4];
  });
  return errs;
}
