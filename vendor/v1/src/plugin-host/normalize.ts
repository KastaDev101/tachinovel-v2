/** Normalization of plugin output into domain types (URLs, statuses, genres, summaries, chapters). */
import * as htmlparser2 from 'htmlparser2';
import type { ChapterMeta, NovelStatus } from '../shared/contracts/domain.ts';
import { URL } from './polyfills/url.ts';

/** LNReader plugin icons/customCSS are paths relative to this (plugins/v3.0.0 branch). */
export const LNREADER_STATIC_BASE = 'https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/public/static/';

export function cleanText(s: unknown): string {
  if (typeof s === 'number' || typeof s === 'boolean') return String(s);
  if (typeof s !== 'string') return '';
  return s.replace(/[\s\u00a0]+/g, ' ').trim();
}

/** An author/artist name without a scraped label ("Author: X", "By X"); undefined if empty or a placeholder. */
export function cleanPerson(s: unknown): string | undefined {
  const name = cleanText(s).replace(/^(?:authors?|artists?|writers?|illustrators?|translators?|by)\s*[:：-]?\s+/i, '').trim();
  return name && !/^(?:n\/?a|unknown|none|-+|updating)$/i.test(name) ? name : undefined;
}

/** Absolute http(s)/data URL for a possibly relative one; undefined for empty/invalid input. */
export function absoluteUrl(u: unknown, base: string): string | undefined {
  if (typeof u !== 'string') return undefined;
  const s = u.trim();
  if (!s) return undefined;
  if (s.startsWith('data:')) return s;
  try {
    const abs = new URL(s.startsWith('//') ? 'https:' + s : s, base);
    return abs.protocol === 'https:' || abs.protocol === 'http:' ? abs.href : undefined;
  } catch {
    return undefined;
  }
}

/** LNReader's "cover not available" placeholders (any repo/branch/extension). */
export function isPlaceholderCover(u: string): boolean {
  return /coverNotAvailable/i.test(u);
}

export function coverUrl(u: unknown, site: string): string | undefined {
  const abs = absoluteUrl(u, site);
  return abs && !isPlaceholderCover(abs) ? abs : undefined;
}

/** Icon or customCSS path from a plugin → absolute URL (relative paths point into the LNReader repo). */
export function staticAssetUrl(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u.trim()) return undefined;
  const s = u.trim();
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) return absoluteUrl(s, LNREADER_STATIC_BASE);
  return absoluteUrl(s.replace(/^\/+/, ''), LNREADER_STATIC_BASE);
}

const EXACT_STATUS: Record<string, NovelStatus> = {
  ongoing: 'ongoing',
  completed: 'completed',
  'publishing finished': 'completed',
  'on hiatus': 'hiatus',
  cancelled: 'cancelled',
  unknown: 'unknown',
  licensed: 'unknown',
  stub: 'unknown',
  inactive: 'hiatus',
};

/** Maps LNReader's NovelStatus strings (and common free-form/localized ones) to domain statuses. */
export function mapStatus(s: unknown): NovelStatus {
  const t = cleanText(s).toLowerCase();
  if (!t) return 'unknown';
  const exact = EXACT_STATUS[t];
  if (exact) return exact;
  if (/cancel|dropped|abandon|discontinu|отмен|заброш|bırakıl|dibatalkan|hủy|ملغ/.test(t)) return 'cancelled';
  if (/hiatus|pause|on hold|suspend|en pausa|заморож|приостан|ara verildi|tạm ngưng|停更|休載|休刊|متوقف/.test(t)) return 'hiatus';
  if (/complet|finish|ended|^end$|conclu|termin|finaliz|tamamlan|selesai|tamat|заверш|закончен|完结|完結|已完|hoàn thành|مكتمل|zakończ|abgeschlossen|fini/.test(t)) return 'completed';
  if (/ongoing|on going|publishing|releas|active|en curso|andamento|en cours|in corso|laufend|продолж|в процессе|выход|выпуска|devam|berlangsung|đang|连载|連載|مستمر|emisi|trwa|em lançamento|updating/.test(t)) return 'ongoing';
  return 'unknown';
}

/** "martial arts" → "Martial Arts", "bl" → "BL"; genres with any capital letter are kept as written. */
function genreCase(name: string): string {
  if (name !== name.toLowerCase()) return name;
  if (/^[a-z]{1,2}$/.test(name)) return name.toUpperCase(); // bl, gl
  return name.replace(/[a-z0-9]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/**
 * "Action, Fantasy; romance" or ["Action", …] → trimmed, de-duplicated (case-insensitive) list.
 * All-lowercase tags get title case; bracketed labels ("[ Completed - Locked ]") are not genres.
 */
export function splitGenres(g: unknown): string[] {
  const parts = Array.isArray(g) ? g.map((x) => cleanText(x)) : typeof g === 'string' ? g.split(/[,;|\n]/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const raw = cleanText(p);
    if (!raw || /^\[.*\]$/.test(raw) || raw.length > 60) continue;
    const name = genreCase(raw);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'table', 'hr', 'section', 'article', 'pre']);
const HIDDEN_TAGS = new Set(['script', 'style', 'noscript']);

/** Summaries that only say "there is none". */
const PLACEHOLDER_SUMMARY = /^(?:n\/?a|none|null|undefined|-+|\.+|no (?:summary|description|synopsis)(?: available| yet)?\.?|\(?see (?:all|more)\)?|read more|show more)$/i;
/** Ad/tracking script that plugins sometimes scrape along with the text (a whole line). */
const SCRIPT_LINE = /adsbygoogle|pubfuturetag|googletag\.|window\.[\w$]+\s*(?:=|\.push\()|document\.write\(/;
/** A leading "Synopsis:" style label. */
const SUMMARY_LABEL = /^(?:synopsis|summary|description|introduction|intro|story)\s*[:：]\s*/i;
/** Site boilerplate: "You're reading “X” Novel at site.com", "Read X on SiteName." (whole line). */
const SITE_SPAM = /you[’']re reading .{0,160}? (?:novel )?(?:at|on) [a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|site|io|co|me|xyz)\.?/gi;
const READ_ON_LINE = /^read .{1,160} (?:on|at) [a-z0-9][\w .-]{0,40}\.?$/i;

/**
 * A novel summary as readable plain text: HTML → text (scripts dropped), one paragraph per line,
 * without placeholder text, ad-script lines, a leading "Synopsis:" label or site boilerplate.
 */
export function cleanSummary(s: unknown): string | undefined {
  const text = htmlToText(s);
  if (!text) return undefined;
  const lines = text
    .split('\n')
    .filter((l) => !SCRIPT_LINE.test(l))
    .map((l) => l.replace(SITE_SPAM, '').trim())
    .filter((l) => l && !READ_ON_LINE.test(l));
  if (lines.length) {
    const first = (lines[0] as string).replace(SUMMARY_LABEL, '').trim();
    if (first) lines[0] = first;
    else lines.shift();
  }
  const out = lines.join('\n').trim();
  return out && !PLACEHOLDER_SUMMARY.test(out) ? out : undefined;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1995 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= (days[m - 1] as number);
}

/** 1–12 for an English month name or abbreviation ("Sep", "Sept", "September"). */
function monthOf(word: string): number | undefined {
  const w = word.toLowerCase();
  if (w.length < 3) return undefined;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w));
  return i >= 0 ? i + 1 : undefined;
}

/**
 * A chapter's release time as an ISO string when it can be read unambiguously, else the source's
 * own string. ISO variants are tidied ("2026-09-15 14:34:56" → "2026-09-15T14:34:56", microseconds
 * → milliseconds, "+0000" → "+00:00"); English dates become ISO dates ("June 9, 2026" →
 * "2026-06-09", "LLL" adds the time); day-first or month-first numeric dates only when the order is
 * certain. Unformatted dayjs tokens ("LL") and pre-1995 placeholder dates (epoch 0) are dropped.
 */
export function normalizeReleaseTime(raw: unknown): string | undefined {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.toISOString();
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    const d = new Date(raw < 1e11 ? raw * 1000 : raw);
    return d.getUTCFullYear() >= 1995 ? d.toISOString() : undefined;
  }
  const s = cleanText(raw);
  if (!s || /^L{1,4}$/i.test(s) || /^invalid date$/i.test(s)) return undefined;

  // ISO-like: date, optional time, optional fraction, optional zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, frac, zone] = iso;
    if (!validDate(Number(y), Number(mo), Number(d))) return Number(y) < 1995 ? undefined : s;
    let out = `${y}-${mo}-${d}`;
    if (h !== undefined && mi !== undefined) {
      out += `T${h}:${mi}:${sec ?? '00'}`;
      if (frac) out += '.' + frac.slice(0, 3).padEnd(3, '0');
      if (zone) out += zone.toUpperCase() === 'Z' ? 'Z' : /^[+-]\d{2}$/.test(zone) ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    }
    return out;
  }

  // "June 9, 2026", "Jun 9th 2026", optionally followed by "3:04 PM".
  const mdy = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?$/.exec(s);
  // "9 June 2026"
  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (mdy || dmy) {
    const month = monthOf((mdy ? mdy[1] : dmy?.[2]) as string);
    const day = Number(mdy ? mdy[2] : dmy?.[1]);
    const year = Number(mdy ? mdy[3] : dmy?.[3]);
    if (month === undefined || !validDate(year, month, day)) return year < 1995 ? undefined : s;
    let out = `${year}-${pad(month)}-${pad(day)}`;
    if (mdy?.[4] !== undefined && mdy[5] !== undefined) {
      let hour = Number(mdy[4]);
      const ampm = mdy[6]?.toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      if (hour < 24) out += `T${pad(hour)}:${mdy[5]}:00`;
    }
    return out;
  }

  // 20/10/2025 or 10/20/2025 (or with dots/dashes): only when the order is certain.
  const num = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const year = Number(num[3]);
    if (year < 1995) return undefined;
    const [month, day] = a > 12 && b <= 12 ? [b, a] : b > 12 && a <= 12 ? [a, b] : [0, 0];
    return month && validDate(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : s;
  }
  return s;
}

/** HTML or text → plain text, one paragraph per line ("\n"-separated), entities decoded. */
export function htmlToText(s: unknown): string | undefined {
  if (typeof s !== 'string') return undefined;
  let text = s;
  if (/<[a-z!/][^>]*>|&[#a-z0-9]+;/i.test(s)) {
    const parts: string[] = [];
    let hidden = 0; // inside <script>/<style>/<noscript>
    const parser = new htmlparser2.Parser(
      {
        onopentag(name) {
          if (HIDDEN_TAGS.has(name)) hidden++;
          if (BLOCK_TAGS.has(name)) parts.push('\n');
        },
        onclosetag(name) {
          if (HIDDEN_TAGS.has(name)) hidden = Math.max(0, hidden - 1);
          if (BLOCK_TAGS.has(name)) parts.push('\n');
        },
        ontext(t) {
          if (!hidden) parts.push(t);
        },
      },
      { decodeEntities: true },
    );
    parser.write(s);
    parser.end();
    text = parts.join('');
  }
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\t \u00a0]+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return lines.length ? lines.join('\n') : undefined;
}

// Port of LNReader's parseChapterNumber (LNReader/lnreader src/utils/parseChapterNumber.ts, MIT),
// used when a plugin gives no chapterNumber, so numbers match what LNReader shows.
const CH_BASIC = /(?<=ch[^\d]*[\s]*)([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
const CH_NUMBER = /([0-9]+)(\.[0-9]+)?(\.?[a-z]+)?/;
const CH_UNWANTED_SPACE = /\s(?=extra|special|omake)/g;
const CH_UNWANTED = /\b(?:v|ver|vol|version|volume|season|s)[^a-z]?[0-9]+/g;

function alphaPostfix(alpha: string): number {
  const n = alpha.charCodeAt(0) - ('a'.charCodeAt(0) - 1);
  return n >= 10 ? 0 : n / 10;
}

function subChapter(decimal: string | undefined, alpha: string | undefined): number {
  if (decimal !== undefined) return Number(decimal);
  if (alpha !== undefined) {
    if (alpha.includes('extra')) return 0.99;
    if (alpha.includes('omake')) return 0.98;
    if (alpha.includes('special')) return 0.97;
    const trimmed = alpha.slice(1);
    if (trimmed.length === 1) return alphaPostfix(trimmed);
  }
  return 0;
}

/**
 * Chapter number from a chapter title ("Chapter 12 - …" → 12, "Ch. 3.5" → 3.5, "#401 - Gambling" →
 * 401, "Vol 2 Episode 7" → 7, "Chapter 5 Extra" → 5.99), the way LNReader does it; undefined when the
 * title has no number. `novelName` is removed first so numbers in the title don't count.
 */
export function chapterNumberFromName(chapterName: string, novelName = ''): number | undefined {
  if (!chapterName) return undefined;
  let name = chapterName.toLowerCase();
  if (novelName) name = name.replace(novelName.toLowerCase(), '').trim();
  name = name.replace(',', '.').replace('-', '.').replace(CH_UNWANTED_SPACE, '').replace(CH_UNWANTED, '');
  const m = CH_BASIC.exec(name) ?? CH_NUMBER.exec(name);
  if (!m) return undefined;
  const n = Number(m[1]) + subChapter(m[2], m[3]);
  return Number.isFinite(n) ? n : undefined;
}

export interface RawChapter {
  name?: unknown;
  path?: unknown;
  releaseTime?: unknown;
  chapterNumber?: unknown;
  locked?: unknown;
  /** LNReader's chapter group: a volume title ("Volume 2", Royal Road's enableVol) or a page number. */
  page?: unknown;
}

/**
 * The volume a chapter belongs to, from LNReader's `page` field. Plain numbers are list pages
 * (page plugins, LNReader shows them as "Page N"), not volumes, so they are left out.
 */
export function volumeOf(page: unknown): string | undefined {
  if (typeof page !== 'string') return undefined;
  const v = cleanText(page);
  if (!v || /^[0-9]+$/.test(v) || v.length > 200) return undefined;
  return v;
}

/**
 * LNReader plugins have no "locked" field; 100+ of them (Madara and LightNovelWP templates, Genesis,
 * WTR, Fenrir, …) mark paywalled chapters with a lock emoji in the name ("🔒 Chapter 12" or
 * "Chapter 12 🔒"). Such chapters become `locked` (never fetched) and lose the emoji (the UI draws its
 * own lock).
 */
const LOCK_EMOJI = new RegExp(`\\s*${String.fromCodePoint(0x1f512)}${String.fromCharCode(0xfe0f)}?\\s*`, 'gu');

function stripLock(name: string): { name: string; locked: boolean } {
  LOCK_EMOJI.lastIndex = 0;
  if (!LOCK_EMOJI.test(name)) return { name, locked: false };
  return { name: name.replace(LOCK_EMOJI, ' ').trim(), locked: true };
}

/** Plugin chapter items → ChapterMeta[] (deduped by path, oldest → newest). */
function givenNumber(raw: RawChapter): number {
  return typeof raw.chapterNumber === 'number' ? raw.chapterNumber : typeof raw.chapterNumber === 'string' ? parseFloat(raw.chapterNumber) : NaN;
}

export function toChapterMetas(items: unknown, novelName = ''): ChapterMeta[] {
  if (!Array.isArray(items)) return [];
  // A plugin that gives every chapter the same number (a placeholder such as 0) gives no numbers.
  const given0 = items.length > 1 && items[0] && typeof items[0] === 'object' ? givenNumber(items[0] as RawChapter) : NaN;
  const placeholderNumbers =
    Number.isFinite(given0) && (items as RawChapter[]).every((r) => r && typeof r === 'object' && givenNumber(r) === given0);
  const seen = new Set<string>();
  const out: ChapterMeta[] = [];
  for (const raw of items as RawChapter[]) {
    if (!raw || typeof raw !== 'object') continue;
    const path = typeof raw.path === 'string' ? raw.path : typeof raw.path === 'number' ? String(raw.path) : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const given = placeholderNumbers ? NaN : givenNumber(raw);
    const lock = stripLock(cleanText(raw.name));
    let name = lock.name;
    const number = Number.isFinite(given) && given > -1 ? given : chapterNumberFromName(name, novelName);
    if (!name) name = number !== undefined ? `Chapter ${number}` : path;
    const meta: ChapterMeta = { path, name };
    if (number !== undefined) meta.number = number;
    const rt = normalizeReleaseTime(raw.releaseTime);
    if (rt) meta.releaseTime = rt;
    if (raw.locked === true || lock.locked) meta.locked = true;
    const volume = volumeOf(raw.page);
    if (volume) meta.volume = volume;
    out.push(meta);
  }
  // Plugins should list oldest first; flip lists that are clearly newest-first.
  const nums = out.map((c) => c.number).filter((n): n is number => n !== undefined);
  if (nums.length >= 2 && nums.length >= out.length * 0.8) {
    let down = 0;
    let up = 0;
    for (let i = 1; i < nums.length; i++) {
      const a = nums[i - 1] as number;
      const b = nums[i] as number;
      if (b < a) down++;
      else if (b > a) up++;
    }
    if (down > 0 && up === 0) out.reverse();
  }
  return out;
}

const TAG_WITH_URL = /<(img|a|source)\b[^>]*>/gi;
const ATTR = /([^\s=>/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];

function attrValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

function quote(v: string): string {
  return `"${v.replace(/"/g, '&quot;')}"`;
}

function absolutize(u: string, base: string): string {
  if (!u || /^(?:https?:|data:|mailto:|tel:|#|javascript:)/i.test(u)) return u;
  return absoluteUrl(u.replace(/&amp;/g, '&'), base)?.replace(/&/g, '&amp;') ?? u;
}

/**
 * Chapter HTML fixed up for display outside the site (the reader renders it from the app's origin):
 * images lazy-loaded by the site (placeholder `src`, real URL in `data-src`/`data-lazy-src`/…) get the
 * real URL as `src`, and relative `src`/`srcset`/`href` URLs become absolute against the chapter URL.
 * Tags that need nothing are left byte-for-byte as they were.
 */
export function fixChapterHtml(html: string, baseUrl: string): string {
  if (!/<(?:img|a|source)\b/i.test(html)) return html;
  return html.replace(TAG_WITH_URL, (tag: string, name: string) => {
    const attrs: [string, string | undefined][] = [];
    const body = tag.slice(name.length + 1, tag.endsWith('/>') ? -2 : -1);
    for (const m of body.matchAll(ATTR)) attrs.push([(m[1] as string).toLowerCase(), attrValue(m[2])]);
    const get = (k: string): string | undefined => attrs.find(([n]) => n === k)?.[1];
    const set = (k: string, v: string): void => {
      const i = attrs.findIndex(([n]) => n === k);
      if (i >= 0) attrs[i] = [k, v];
      else attrs.push([k, v]);
    };
    let changed = false;
    const lower = name.toLowerCase();
    if (lower === 'img' || lower === 'source') {
      const src = get('src');
      const lazy = LAZY_SRC.map(get).find((v) => v && !v.startsWith('data:'));
      if (lazy && (!src || src.startsWith('data:') || /placeholder|blank|lazy|spacer|loading/i.test(src))) {
        set('src', lazy);
        changed = true;
      }
      const lazySet = LAZY_SRCSET.map(get).find((v) => v);
      if (lazySet && !get('srcset')) {
        set('srcset', lazySet);
        changed = true;
      }
      for (const k of ['src', 'srcset'] as const) {
        const v = get(k);
        if (!v) continue;
        const fixed = k === 'src' ? absolutize(v, baseUrl) : v.split(',').map((part) => part.trim().replace(/^\S+/, (u) => absolutize(u, baseUrl))).join(', ');
        if (fixed !== v) {
          set(k, fixed);
          changed = true;
        }
      }
    } else {
      const href = get('href');
      if (href) {
        const fixed = absolutize(href, baseUrl);
        if (fixed !== href) {
          set('href', fixed);
          changed = true;
        }
      }
    }
    if (!changed) return tag;
    return `<${name}${attrs.map(([k, v]) => (v === undefined ? ` ${k}` : ` ${k}=${quote(v)}`)).join('')}${tag.endsWith('/>') ? ' />' : '>'}`;
  });
}

/** LNReader's fallback for resolveUrl: site + path (with exactly one slash between them). */
export function joinSitePath(site: string, path: string): string {
  if (/^(https?:)?\/\//i.test(path)) return path.startsWith('//') ? 'https:' + path : path;
  if (site.endsWith('/') && path.startsWith('/')) return site + path.slice(1);
  if (!site.endsWith('/') && !path.startsWith('/') && path !== '') return site + '/' + path;
  return site + path;
}
