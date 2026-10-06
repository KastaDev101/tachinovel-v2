/**
 * Chapter text quality pass, run by chapter.get after the user's cleanup rules. It keeps the source
 * HTML structure (tags, attributes, nesting), is a handful of linear regex passes each guarded by a
 * cheap test (no JIT on the phone), and returns clean chapters unchanged (see the Stonescape and
 * Royal Road fixtures in the tests).
 *
 * - mojibake: UTF-8 that was decoded as Windows-1252 is re-decoded ("â€™" → "’", "Ã©" → "é",
 *   "ðŸ˜€" → "😀"), but only for byte sequences that are valid UTF-8 *and* plausible for English
 *   web novels (punctuation, Latin-1, Latin Extended-A, CJK punctuation/kana, fullwidth, emoji).
 *   Legit text such as "café…”" or "JOSÉ’S" is left alone.
 * - zero-width spaces, BOMs and word joiners are removed (ZWJ/ZWNJ stay: emoji and scripts need them)
 * - <br>: runs of 3+ become 2; <br> right inside a paragraph's edges and at the very start/end go
 * - empty paragraphs (whitespace, &nbsp;, <br>, empty inline wrappers): leading/trailing ones are
 *   dropped; elsewhere a run becomes one scene break `<p>&nbsp;</p>`. When empties are used as
 *   spacers between most paragraphs, single ones are dropped and only runs of 2+ become a break.
 * - &nbsp; / U+00A0 become plain spaces (indentation and justification are the reader's job), except
 *   inside the scene-break paragraph, which needs it to keep its height.
 */

/** Windows-1252 characters for bytes 0x80–0x9F (the rest of 0x80–0xFF is Latin-1). */
const CP1252_BYTE: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** A UTF-8 lead byte seen as Latin-1, then 1–3 continuation bytes seen as Latin-1/Windows-1252. */
const MOJIBAKE_RE = /[\u00C2-\u00F4][\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]{1,3}/g;
const MOJIBAKE_HINT = /[\u00C2-\u00F4]/;

function byteOf(ch: string): number | undefined {
  const c = ch.charCodeAt(0);
  return c <= 0xff ? c : CP1252_BYTE[c];
}

function plausible(lead: number, second: number, n: number): boolean {
  // 2 bytes: U+0080–U+017F (Latin-1 supplement, Latin Extended-A). Later leads are mostly real
  // uppercase accents next to punctuation ("JOSÉ’S", "«CAFÉ»").
  if (n === 2) return lead <= 0xc5;
  // 3 bytes: U+2000–U+2FFF punctuation/symbols, U+3000–U+30FF CJK punctuation/kana, U+FEFF/U+FFxx.
  // Other leads are lowercase accents (à…ï) that legitimately sit before "…”" or "’’".
  if (n === 3) return lead === 0xe2 || (lead === 0xe3 && second <= 0x83) || (lead === 0xef && second >= 0xbb);
  return lead === 0xf0 && second === 0x9f; // emoji, U+1F000–U+1FFFF
}

/** Re-decodes one suspicious run; returns it unchanged unless it is valid, plausible UTF-8. */
function repairRun(run: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < run.length; i++) {
    const b = byteOf(run.charAt(i));
    if (b === undefined) return run;
    bytes.push(b);
  }
  const lead = bytes[0] as number;
  const n = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  // "â€" whose third byte (0x9D, undefined in Windows-1252) was dropped is a closing quote.
  if (bytes.length < n) return run === '\u00E2\u20AC' ? '\u201D' : run;
  let cp = lead & (n === 2 ? 0x1f : n === 3 ? 0x0f : 0x07);
  for (let i = 1; i < n; i++) {
    const b = bytes[i] as number;
    if (b < 0x80 || b > 0xbf) return run;
    cp = (cp << 6) | (b & 0x3f);
  }
  const min = n === 2 ? 0x80 : n === 3 ? 0x800 : 0x10000;
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return run;
  if (!plausible(lead, bytes[1] as number, n)) return run;
  return String.fromCodePoint(cp) + run.slice(n);
}

export function fixMojibake(s: string): string {
  if (!MOJIBAKE_HINT.test(s)) return s;
  // "Â" + space is a mangled no-break space whose second byte was already normalized away.
  return s.replace(MOJIBAKE_RE, repairRun).replace(/\u00C2(?= )/g, '');
}

const ZERO_WIDTH = /[\u200B\u2060\uFEFF]/g;
const ZERO_WIDTH_HINT = /[\u200B\u2060\uFEFF]/;

const BR = String.raw`<br\s*\/?>`;
const BR_HINT = /<br/i;
const BR_RUN = new RegExp(`(?:${BR}\\s*){2,}${BR}`, 'gi');
const BR_AFTER_P_OPEN = new RegExp(`(<p\\b[^>]*>)(?:\\s*${BR})+`, 'gi');
const BR_BEFORE_P_CLOSE = new RegExp(`(?:${BR}\\s*)+(?=<\\/p>)`, 'gi');
const BR_AT_START = new RegExp(`^(?:\\s*${BR})+`, 'i');
const BR_AT_END = new RegExp(`(?:${BR}\\s*)+$`, 'i');

/** Content that leaves a paragraph visually empty. The alternatives are disjoint, so no backtracking blow-up. */
const BLANK = String.raw`(?:\s|&nbsp;|&#160;|&#xa0;|<br\s*\/?>|<\/?(?:span|b|i|em|strong|u|font)\b[^>]*>)`;
const EMPTY_P = String.raw`<p\b[^>]*>${BLANK}*<\/p>`;
const EMPTY_P_RUN = new RegExp(`${EMPTY_P}(?:\\s*${EMPTY_P})*`, 'gi');
const EMPTY_P_ONE = new RegExp(EMPTY_P, 'gi');
const P_OPEN = /<p\b/gi;
const SCENE_BREAK = '<p>&nbsp;</p>';

const NBSP_HINT = /&nbsp;|&#160;|&#xa0;|\u00A0/i;
const NBSP = /<p>&nbsp;<\/p>|&nbsp;|&#160;|&#xa0;|\u00A0/gi;

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s)) n++;
  return n;
}

function hasText(html: string): boolean {
  return /\S/.test(html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xa0;/gi, ''));
}

function collapseEmptyParagraphs(s: string): string {
  const runs: { start: number; end: number; count: number }[] = [];
  EMPTY_P_RUN.lastIndex = 0;
  for (let m = EMPTY_P_RUN.exec(s); m; m = EMPTY_P_RUN.exec(s)) {
    runs.push({ start: m.index, end: m.index + m[0].length, count: countMatches(EMPTY_P_ONE, m[0]) });
  }
  if (runs.length === 0) return s;
  const first = runs[0] as { start: number };
  const last = runs[runs.length - 1] as { end: number };
  const leading = !hasText(s.slice(0, first.start));
  const trailing = !hasText(s.slice(last.end));
  const empties = runs.reduce((sum, r) => sum + r.count, 0);
  const gaps = countMatches(P_OPEN, s) - empties - 1;
  const interior = runs.length - (leading ? 1 : 0) - (trailing && runs.length > 1 ? 1 : 0);
  // Spacer markup (an empty paragraph in most gaps between paragraphs): only a run of 2+ is a break.
  const minBreak = interior >= 3 && interior * 2 >= gaps ? 2 : 1;
  let out = '';
  let at = 0;
  runs.forEach((r, i) => {
    const edge = (i === 0 && leading) || (i === runs.length - 1 && trailing);
    out += s.slice(at, r.start) + (edge || r.count < minBreak ? '' : SCENE_BREAK);
    at = r.end;
  });
  return out + s.slice(at);
}

export function polishChapterHtml(html: string): string {
  let s = fixMojibake(html);
  if (ZERO_WIDTH_HINT.test(s)) s = s.replace(ZERO_WIDTH, '');
  if (BR_HINT.test(s)) {
    s = s
      .replace(BR_RUN, '<br><br>')
      .replace(BR_AFTER_P_OPEN, '$1')
      .replace(BR_BEFORE_P_CLOSE, '')
      .replace(BR_AT_START, '')
      .replace(BR_AT_END, '');
  }
  if (s.includes('</p>') || s.includes('</P>')) s = collapseEmptyParagraphs(s);
  if (NBSP_HINT.test(s)) s = s.replace(NBSP, (m) => (m.length > 6 ? m : ' '));
  return s;
}
