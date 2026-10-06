/** Chapter heading text helpers (pure; unit-tested). */
import { firstNumber } from './chapters.ts';

function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** "Chapter 12: The Gate" → { label: "Chapter 12", title: "The Gate" }. */
export function splitChapterTitle(title: string, number?: number): { label: string; title: string } {
  const m = /^\s*(?:chapter|chap\.?|ch\.?|episode|ep\.?)\s*(\d+(?:\.\d+)?)\s*(?:[:.\-–—]\s*)?(.*)$/i.exec(title);
  if (m) {
    const rest = (m[2] ?? '').trim();
    return rest ? { label: `Chapter ${m[1] ?? ''}`, title: rest } : { label: '', title: `Chapter ${m[1] ?? ''}` };
  }
  const n = number ?? firstNumber(title);
  return { label: n !== undefined && !title.includes(String(n)) ? `Chapter ${n}` : '', title };
}

/**
 * Hide a leading block that repeats the chapter heading (many sources start the HTML with their own
 * title, e.g. Stonescape's "<p>Ch 0 - Prologue</p>").
 */
export function isTitleEcho(text: string, title: string, number?: number): boolean {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  const a = norm(t);
  const b = norm(title);
  const { title: bare } = splitChapterTitle(title, number);
  const c = norm(bare);
  if (a.length > 2 && (a === b || a === c || (b.includes(a) && a.length > 8) || (a.includes(b) && b.length > 8))) return true;
  const n = number ?? firstNumber(title);
  if (n !== undefined) {
    const m = /^\s*(?:chapter|chap\.?|ch\.?|episode|ep\.?|#)?\s*(\d+(?:\.\d+)?)\b\s*(?:[:.\-–—]\s*)?(.*)$/i.exec(t);
    if (m && Number(m[1]) === n && (!m[2] || norm(m[2]) === c || c.includes(norm(m[2])))) return true;
  }
  return false;
}
