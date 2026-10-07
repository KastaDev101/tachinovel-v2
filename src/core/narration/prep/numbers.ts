/**
 * Numbers in words for narration (text prep, src/core/narration/prep). Pure ES2023: runs in the core
 * (JavaScriptCore) and in the UI. Built on v1's numberToWords/ordinalToWords (the PC narrator's), so a
 * number sounds the same everywhere: "304" → "three hundred and four".
 */
import { numberToWords, ordinalToWords } from '@v1tts/frontend.ts';

const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** More digits than this are read one by one (IDs, codes): beyond v1's billions. */
const MAX_CARDINAL_DIGITS = 12;

/** Digits one by one: "007" → "zero zero seven". */
export function digitsToWords(digits: string): string {
  return [...digits].map((d) => DIGIT[Number(d)] ?? d).join(' ');
}

/**
 * A whole number written with digits (and optional thousands commas, "1,000") in words. Leading zeros
 * and very long numbers are read digit by digit.
 */
export function cardinalWords(raw: string): string {
  const digits = raw.replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return raw;
  if ((digits.length > 1 && digits.startsWith('0')) || digits.length > MAX_CARDINAL_DIGITS) return digitsToWords(digits);
  return numberToWords(Number(digits));
}

/** "3.14" → "three point one four"; "1,500.5" → "one thousand five hundred point five". */
export function decimalWords(raw: string): string {
  const [int = '', frac] = raw.split('.');
  const head = int === '' ? 'zero' : cardinalWords(int);
  return frac === undefined || frac === '' ? head : `${head} point ${digitsToWords(frac)}`;
}

/** Ordinal of a whole number: 21 → "twenty-first". */
export function ordinalWords(n: number): string {
  return ordinalToWords(n);
}

/**
 * A year the way it is said: 1999 → "nineteen ninety-nine", 1905 → "nineteen oh five", 1900 →
 * "nineteen hundred", 2005 → "two thousand and five", 2026 → "twenty twenty-six", 1066 → "ten sixty-six".
 */
export function yearWords(n: number): string {
  if (!Number.isInteger(n) || n < 1000 || n > 2099) return numberToWords(n);
  if (n >= 2000 && n < 2010) return numberToWords(n);
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return n % 1000 === 0 ? numberToWords(n) : `${numberToWords(hi)} hundred`;
  if (n < 1100 && n % 1000 < 10) return numberToWords(n);
  return `${numberToWords(hi)} ${lo < 10 ? `oh ${numberToWords(lo)}` : numberToWords(lo)}`;
}

/** Plural of a number's last word: "ninety" → "nineties", "nineteen hundred" → "nineteen hundreds". */
function pluralWords(words: string): string {
  return words.replace(/([a-z]+)$/, (w) => (w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`));
}

/** Decades: "1990s" → "nineteen nineties", "90s" → "nineties", "1800s" → "eighteen hundreds". */
export function decadeWords(digits: string): string {
  const n = Number(digits);
  if (digits.length === 4) return pluralWords(yearWords(n));
  return pluralWords(numberToWords(n));
}

const SCALES: Record<string, string> = {
  k: 'thousand',
  thousand: 'thousand',
  m: 'million',
  million: 'million',
  mil: 'million',
  bn: 'billion',
  b: 'billion',
  billion: 'billion',
  trillion: 'trillion',
};

/** "10k" → "ten thousand", "2.5M" → "two point five million". */
export function scaledWords(amount: string, scale: string): string {
  const word = SCALES[scale.toLowerCase()];
  const head = amount.includes('.') ? decimalWords(amount) : cardinalWords(amount);
  return word ? `${head} ${word}` : head;
}

const CURRENCIES: Record<string, [one: string, many: string, centOne: string, centMany: string]> = {
  $: ['dollar', 'dollars', 'cent', 'cents'],
  '£': ['pound', 'pounds', 'penny', 'pence'],
  '€': ['euro', 'euros', 'cent', 'cents'],
  '¥': ['yen', 'yen', '', ''],
  '₩': ['won', 'won', '', ''],
  '₹': ['rupee', 'rupees', 'paisa', 'paise'],
};

/**
 * Money: "$5" → "five dollars", "$1" → "one dollar", "$5.50" → "five dollars and fifty cents", "$0.99" →
 * "ninety-nine cents", "$1.5 million" → "one point five million dollars", "€10k" → "ten thousand euros".
 */
export function moneyWords(symbol: string, amount: string, scale?: string): string {
  const names = CURRENCIES[symbol];
  if (!names) return `${amount}`;
  const [one, many, centOne, centMany] = names;
  if (scale) return `${scaledWords(amount, scale)} ${many}`;
  const [intRaw = '0', frac] = amount.split('.');
  const int = Number(intRaw.replace(/,/g, '') || '0');
  const whole = `${cardinalWords(intRaw || '0')} ${int === 1 ? one : many}`;
  if (frac === undefined) return whole;
  if (frac.length !== 2 || !centOne) return `${decimalWords(amount.replace(/,/g, ''))} ${many}`;
  const cents = Number(frac);
  if (cents === 0) return whole;
  const centWords = `${numberToWords(cents)} ${cents === 1 ? centOne : centMany}`;
  return int === 0 ? centWords : `${whole} and ${centWords}`;
}

/** Clock times: (3, 30) → "three thirty", (10, 5) → "ten oh five", (12, 0) → "twelve o'clock", with "PM". */
export function timeWords(h: number, m: number, suffix?: 'AM' | 'PM'): string {
  const hour = numberToWords(h);
  if (m === 0) return suffix ? `${hour} ${suffix}` : h === 0 ? 'midnight' : `${hour} o'clock`;
  const minutes = m < 10 ? `oh ${numberToWords(m)}` : numberToWords(m);
  return `${hour} ${minutes}${suffix ? ` ${suffix}` : ''}`;
}

const FRACTION_NAMES: Record<number, [one: string, many: string]> = { 2: ['half', 'halves'], 4: ['quarter', 'quarters'] };

/** Small fractions: 1/2 → "one half", 3/4 → "three quarters", 2/3 → "two thirds". */
export function fractionWords(n: number, d: number): string {
  const named = FRACTION_NAMES[d];
  const name = named ? (n === 1 ? named[0] : named[1]) : `${ordinalToWords(d)}${n === 1 ? '' : 's'}`;
  return `${numberToWords(n)} ${name}`;
}
