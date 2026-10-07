/**
 * What is NOT read aloud (text prep): a plan per chapter block. Conservative by design: a rule only fires on
 * text that can't be story (labels like "T/N:", web addresses with "read at", "Previous Chapter | Next");
 * anything in doubt is read.
 *
 * With "Skip translator & author notes" on (the default):
 *  - translator/editor/author notes: a block starting with a note label ("TL note:", "T/N", "[TN: …]",
 *    "Translator:", "Edited by", "A/N", "Author's note:"); an "Author's Note" heading near the end of the
 *    chapter takes the short note blocks after it along; inline notes inside a sentence ("qi [TN: life
 *    energy]") and footnote marks ("[1]");
 *  - Patreon/Discord/Ko-fi plugs: a link to one anywhere, or a short call to action addressed to the reader
 *    ("Join our Discord", "Support me on Patreon", "Thanks for reading!") at the chapter's start or end.
 * Always (never story):
 *  - navigation text ("Previous Chapter | Table of Contents | Next Chapter", "<< Prev");
 *  - anti-theft insertions: a sentence naming a web address (or a known reading site) together with "read
 *    at", "this chapter is from", "stolen", "latest chapters"… (inside a paragraph only that sentence goes);
 *  - the chapter title repeated at the top (the most complete one is read);
 *  - decorative separators ("x-x-x", "oOo", "◇◇◇") become a scene-break pause instead of being read.
 */
import { splitSentences, type SourceBlock, type Span } from '@v1tts/frontend.ts';

export type SkipReason = 'note' | 'plug' | 'nav' | 'antitheft' | 'title-repeat' | 'stat-table';

export interface BlockPlan {
  /** Not read at all. */
  skip?: SkipReason;
  /** A decorative separator: a scene-break pause. */
  separator?: boolean;
  /** A LitRPG system message / status window (system.ts). */
  system?: boolean;
  /** Stat table this block belongs to (index into PreparedPlan.tables). */
  table?: number;
  /** Parts of the block left out (inline notes, an anti-theft sentence), in the block's canonical text. */
  drops?: Span[];
}

export interface CleanupOptions {
  /** Chapter title from the source (finds the title line at the top). */
  title?: string;
  /** Skip translator/editor/author notes and Patreon/Discord plugs. Default true. */
  skipNotes?: boolean;
}

const NOTE_LABEL = String.raw`(?:T\/?L\s*N(?:ote)?s?|T\/?N|TLN|N\/T|TL(?:\s*note)?s?|Translator(?:['’]s)?(?:\s*(?:notes?|thoughts|comments?))?|Translated\s+by|Trans(?:lation)?\s+notes?|E\/N|ED\/N|Editor(?:['’]s)?(?:\s*notes?)?|Edited\s+by|Proofread(?:er|ed\s+by)?|PR\/N|PR|QC|A\/N|AN|Author(?:['’]s)?(?:\s*(?:notes?|thoughts|words|comments?))?|From\s+the\s+author)`;
/** A block that starts with a note label and a separator ("TL note: …", "[T/N: …]", "Translator: X"). */
const NOTE_LINE = new RegExp(String.raw`^[\s[(（【<*]*${NOTE_LABEL}\s*[:：\-–—)\]】>]`, 'i');
/** A note heading on its own ("Author's Note", "A/N:", "~ Translator's Notes ~"). */
const NOTE_HEADING = new RegExp(String.raw`^[\s[(（【<*~=\-]*${NOTE_LABEL}[\s:：.)\]】>*~=\-]*$`, 'i');
/** A note inside a sentence: "[TN: …]", "(T/N: …)", "【Author's note: …】". */
const INLINE_NOTE = new RegExp(String.raw`\s?[[(（【]\s*(?:T\/?L\s*N(?:ote)?|T\/?N|TLN|N\/T|TL\s*note|Translator(?:['’]s)?\s*notes?|Trans(?:lation)?\s*note|E\/N|Editor(?:['’]s)?\s*note|PR\/N|A\/N|Author(?:['’]s)?\s*note)(?![\p{L}])\s*[:：\-–—]?[^\])）】]{0,500}[\])）】]`, 'giu');
/** Footnote marks after a word: "qi[1]", "Dao.[2]". */
const FOOTNOTE_MARK = /(?<=[\p{L}\p{N}.,!?;:"”’'])\[\d{1,2}\]/gu;

const PLUG_LINK = /(?:patreon\.com|ko-?fi\.com|discord\.(?:gg|com\/invite)|paypal\.me|buymeacoffee\.com|subscribestar\.com)/i;
const PLUG_WORD =
  /\b(?:patreon|ko-?fi|discord|paypal|subscribestar|power\s*stones?|golden\s*tickets?|advanced?\s+chapters?|early\s+access|donat(?:e|ions?|ing)|bonus\s+chapters?|mass\s+release|release\s+schedule|(?:rate|vote)\s+(?:and|&)\s+review|leave\s+a\s+(?:review|rating|comment)|add\s+(?:it|this(?:\s+novel)?)\s+to\s+your\s+library|my\s+other\s+(?:novels?|stor(?:y|ies)|works?))\b/i;
/** Plugs speak to the reader. */
const ADDRESS = /\b(?:my|our|us|me|you|your)\b/i;
const THANKS = /^(?:thanks?|thank\s+you)\s+(?:(?:so|very)\s+much\s+)?for\s+reading\b/i;

const NAV_TOKENS = /\b(?:previous|prev|next|chapters?|chap|ch|table\s+of\s+contents|contents|toc|index|home|back\s+to\s+top|go\s+back|chapter\s+list|novel\s+page)\b\.?/gi;
const NAV_KEY = /\b(?:previous|prev|next|toc|table\s+of\s+contents|index)\b/i;

const DOMAIN = /[\p{L}\p{N}-]{2,}\s?(?:\.|\(\s?dot\s?\)|\s+dot\s+)\s?(?:c\s?[o0]\s?m|n\s?[e3]\s?t|org|xyz|io|co|me|info|online|site|top|club|tv|cc)\b/iu;
const SITE_NAME =
  /\b(?:novel\s?bin|novel\s?full|wuxia\s?world|web\s?novel|royal\s?road|scribble\s?hub|light\s?novel\s?(?:pub|world)|novel\s?updates|free\s?web\s?novel|read\s?light\s?novel|box\s?novel|mtl\s?novel|novel\s?fire|novel\s?buddy|novel\s?hall|read\s?novel\s?full|novel\s?next|fan\s?mtl|wtr-?lab|panda\s?novel|novel\s?pub|bed\s?novel|all\s?novel)\b/i;
const STRONG_THEFT =
  /\b(?:this\s+(?:chapter|novel|content|translation|story)\s+(?:is|was|has\s+been)\b|stolen|pirated|reposted|copied\s+from|uploaded\s+(?:without|by)|(?:latest|new(?:est)?|original|updated?|faster|authori[sz]ed)\b[^.!?\n]{0,30}\b(?:chapters?|novels?|releases?|updates?|translations?|experience)\b|visit(?:ing)?\b|please\s+(?:click|support|read)|source\s+of\s+this)/i;
const WEAK_THEFT = /\b(?:read|find|enjoy|continue|get)\b[^.!?\n]{0,40}\b(?:at|on|from|in)\b/i;

/** "Chapter 12", "Ch. 3", "Prologue", "Extra: The Feast" (v1 frontend's title rule). */
const TITLE_RE =
  /^(?:(?:chapter|chap\.?|ch\.?|episode|ep\.?|part|volume|vol\.?|book)\s*(?:\d+(?:\.\d+)?|[IVXLC]+\b)|(?:prologue|epilogue|interlude|side story|extra|afterword|bonus chapter)\b(?=\s*(?:$|[-–—:.|(\d])))/i;

const SEPARATOR_LETTERS = /^(?:[xXoO0][\s\-~=*_.·•+|<>◇◆○●]+)+[xXoO0]?$|^[\s\-~=*_.·•+|<>◇◆○●]+(?:[xXoO0][\s\-~=*_.·•+|<>◇◆○●]+)+$|^(?:oO)+o?$|^(?:Oo)+O?$|^(?:xX)+x?$|^(?:Xx)+X?$|^o0o$|^0o0$/;

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A decorative separator line: no words, or only an x/o pattern between symbols ("x-x-x", "oOo"). */
export function isSeparator(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // No words: a separator, unless it is a beat of punctuation ("……", "?!", "—") the front-end handles.
  if (!/[\p{L}\p{N}]/u.test(t)) return !/^[\s.…!?‽"'“”‘’,;:—–-]*$/u.test(t) || /^[\s\-—–=*~_]{3,}$/u.test(t);
  return SEPARATOR_LETTERS.test(t);
}

/** Navigation text: "Previous Chapter | Next Chapter", "<< Prev | ToC | Next >>". */
export function isNavigation(text: string): boolean {
  const t = text.trim();
  if (t.length > 90 || !NAV_KEY.test(t)) return false;
  const tokens = t.match(NAV_TOKENS) ?? [];
  const rest = t.replace(NAV_TOKENS, '').replace(/[\s|｜/\\•·\-–—<>«»←→‹›()[\]:.,~*>]+/g, '').replace(/\d+/g, '');
  if (rest) return false;
  return tokens.length >= 2 || /[<>«»←→‹›|｜]/.test(t);
}

/** An anti-theft insertion ("Read the latest chapters at n0velbin.c0m", "This chapter is from <site>"). */
export function isAntiTheft(sentence: string): boolean {
  if (sentence.length > 300) return false;
  const domain = DOMAIN.test(sentence);
  if (domain && (STRONG_THEFT.test(sentence) || WEAK_THEFT.test(sentence))) return true;
  return SITE_NAME.test(sentence) && STRONG_THEFT.test(sentence);
}

/** A Patreon/Discord plug. `edge`: the block is at the chapter's start or end. */
export function isPlug(text: string, edge: boolean): boolean {
  const t = text.trim();
  if (t.length > 600 || /["“”«»「」]/.test(t)) return false;
  if (PLUG_LINK.test(t)) return true;
  if (!edge) return false;
  if (THANKS.test(t)) return true;
  return PLUG_WORD.test(t) && ADDRESS.test(t);
}

export function isNoteLine(text: string): boolean {
  return NOTE_LINE.test(text.trim());
}

export function isNoteHeading(text: string): boolean {
  return NOTE_HEADING.test(text.trim());
}

function looksLikeTitle(b: SourceBlock, title: string | undefined): boolean {
  const t = b.text.trim();
  if (!t || t.length > 160 || t.includes('\n')) return false;
  if (TITLE_RE.test(t) || /^h[1-6]$/.test(b.tag)) return true;
  if (!title) return false;
  const a = norm(t);
  const c = norm(title);
  return c.length > 0 && (a === c || a.endsWith(c) || c.endsWith(a));
}

/** Two title lines name the same chapter: one contains the other, or the same chapter number. */
function sameTitle(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const n = (s: string): string | undefined => /(?:chapter|chap|ch|episode|ep)\.?\s*(\d+(?:\.\d+)?)/i.exec(s)?.[1];
  const na = n(a);
  return na !== undefined && na === n(b);
}

/** Spans of `text` to leave out: inline notes and footnote marks (with notes skipped), anti-theft sentences. */
export function inlineDrops(text: string, skipNotes: boolean): Span[] {
  const drops: Span[] = [];
  if (skipNotes && /[[(（【]/.test(text)) {
    for (const re of [INLINE_NOTE, FOOTNOTE_MARK]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) drops.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (DOMAIN.test(text) || SITE_NAME.test(text)) {
    for (const sp of splitSentences(text)) if (isAntiTheft(text.slice(sp.start, sp.end))) drops.push(sp);
  }
  drops.sort((a, b) => a.start - b.start);
  return drops;
}

/** Characters left when the drops are taken out (0: nothing left to read). */
function remaining(text: string, drops: readonly Span[]): string {
  let out = '';
  let at = 0;
  for (const d of drops) {
    if (d.start > at) out += text.slice(at, d.start);
    at = Math.max(at, d.end);
  }
  return out + text.slice(at);
}

/** The chapter's cleanup plan: one entry per block (system messages and stat tables are added by system.ts). */
export function cleanupPlan(blocks: readonly SourceBlock[], opts: CleanupOptions = {}): BlockPlan[] {
  const skipNotes = opts.skipNotes !== false;
  const plans: BlockPlan[] = blocks.map(() => ({}));
  const content = blocks.map((b, i) => (b.text.trim() && b.tag !== 'hr' ? i : -1)).filter((i) => i >= 0);
  const rank = new Map(content.map((bi, k) => [bi, k]));
  const n = content.length;
  /** Start: the first 3 content blocks; end: the last quarter (at least the last 3). */
  const atStart = (bi: number): boolean => (rank.get(bi) ?? 0) < 3;
  const atEnd = (bi: number): boolean => (rank.get(bi) ?? 0) >= Math.min(n - 3, Math.floor(n * 0.75));

  blocks.forEach((b, i) => {
    const plan = plans[i] as BlockPlan;
    const text = b.text.trim();
    if (!text || b.tag === 'hr') return;
    if (isSeparator(text)) {
      plan.separator = true;
      return;
    }
    if (isNavigation(text)) {
      plan.skip = 'nav';
      return;
    }
    if (skipNotes && isNoteLine(text)) {
      plan.skip = 'note';
      return;
    }
    if (skipNotes && isPlug(text, atStart(i) || atEnd(i))) {
      plan.skip = 'plug';
      return;
    }
    const drops = inlineDrops(b.text, skipNotes);
    if (drops.length > 0) {
      if (!/[\p{L}\p{N}]/u.test(remaining(b.text, drops))) plan.skip = drops.some((d) => isAntiTheft(b.text.slice(d.start, d.end))) ? 'antitheft' : 'note';
      else plan.drops = drops;
    }
  });

  // A note heading takes the short note blocks after it along: to the end of the chapter (near the end),
  // or up to the next separator / title (at the start). Elsewhere only the heading itself goes.
  if (skipNotes) {
    for (const bi of content) {
      const plan = plans[bi] as BlockPlan;
      if (plan.skip || !isNoteHeading(blocks[bi]?.text ?? '')) continue;
      plan.skip = 'note';
      const end = atEnd(bi);
      const start = atStart(bi);
      if (!end && !start) continue;
      const taken: number[] = [];
      // The note ends at a separator, a title or the chapter's end; a long or quoted block is story.
      let bounded = true;
      for (const x of content.filter((c) => c > bi)) {
        const bx = blocks[x] as SourceBlock;
        const px = plans[x] as BlockPlan;
        if (px.separator || looksLikeTitle(bx, opts.title)) break;
        if (px.skip) continue;
        if (taken.length >= 12 || bx.text.length > 700 || /^["“「『]/.test(bx.text.trim())) {
          bounded = false;
          break;
        }
        taken.push(x);
      }
      if (end || (start && bounded && taken.length <= 4)) for (const x of taken) (plans[x] as BlockPlan).skip = 'note';
    }
  }

  // The chapter title repeated at the top: read the most complete one. Notes and plugs (read when notes are
  // on) may sit between the copies; the first story block ends the top.
  const head: number[] = [];
  for (const bi of content.slice(0, 6)) {
    const plan = plans[bi] as BlockPlan;
    const text = blocks[bi]?.text ?? '';
    if (plan.skip || plan.separator) continue;
    if (looksLikeTitle(blocks[bi] as SourceBlock, opts.title)) head.push(bi);
    else if (!(isNoteLine(text) || isNoteHeading(text) || isPlug(text, true))) break;
  }
  if (head.length > 1) {
    const texts = head.map((bi) => blocks[bi]?.text ?? '');
    const keep = head.reduce((best, bi, k) => (norm(texts[k] ?? '').length > norm(blocks[best]?.text ?? '').length ? bi : best), head[0] as number);
    for (const bi of head) {
      if (bi !== keep && sameTitle(blocks[bi]?.text ?? '', blocks[keep]?.text ?? '')) (plans[bi] as BlockPlan).skip = 'title-repeat';
    }
  }
  return plans;
}
