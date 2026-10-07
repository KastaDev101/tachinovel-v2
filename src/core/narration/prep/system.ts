/**
 * LitRPG system messages and status windows (text prep). A block is a system message when every line is
 * one of:
 *  - a bracketed notice: "[Skill acquired: Shadow Step]", "<Quest Complete>", "【Level Up!】", "[Status]",
 *    unless it reads like speech in brackets (telepathy, a phone screen: "<Where are you?>", "[Hey, wait!]");
 *  - a notification: "Ding!", "*Ding*", "Level up!", "Quest completed.", "You have gained 50 EXP.";
 *  - a stat line inside a stat table ("Strength: 12", "HP: 120/120", "Class: Shadow").
 * Stat tables are three or more stat lines in a row (in one block or one line per block), optionally under
 * a heading ("Status", "[Stats]"). They are read in full, as a short summary (default) or skipped.
 */
import type { SourceBlock } from '@v1tts/frontend.ts';
import type { BlockPlan } from './cleanup.ts';

export type StatTableMode = 'full' | 'short' | 'skip';

export interface StatEntry {
  key: string;
  value: string;
}

export interface StatTable {
  /** Blocks of the table, in order (the first one anchors the summary). */
  blocks: number[];
  heading?: string;
  entries: StatEntry[];
}

const OPEN = '[【<〈《';
const CLOSE = ']】>〉》';
const BRACKETED = /^\s*([[【<〈《])([^\n]*)([\]】>〉》])\s*[.!]?\s*$/u;

/** Words of system notices. */
const SYSTEM_WORD =
  /\b(?:skills?|spells?|level(?:ed|led)?|lv|lvl|quests?|status|titles?|class(?:es)?|rank(?:ed)?|tier|grade|acquired|obtained|gained|learned|learnt|unlocked|received|rewards?|achievements?|warning|alert|notice|notification|system|exp|xp|hp|mp|sp|stats?|strength|agility|dexterity|vitality|endurance|intelligence|wisdom|luck|perception|attributes?|points?|evolution|evolved|upgraded?|ding|slain|killed|defeated|completed?|failed|inventory|item|equipment|mana|stamina|health|bonus|buff|debuff|cooldown|proficiency|mastery|affinity|conditions?|identified|appraisal|analy[sz]e|bloodline|realm|cultivation|breakthrough|host|congratulations)\b/i;
/** Speech in brackets: a person talking ("I", "we", "you're"…). */
const SPEECHY = /\b(?:I|I'm|I'll|I've|I'd|me|my|we|we're|us|our|you're|you'll|don't|can't|won't|let's|please|hey|hi|hello)\b/i;

const NOTIFICATION =
  /^\s*(?:\*?\s*ding(?:\s*[!~.]+)?\s*\*?(?:\s|$)|level\s+up\b|skill\s+(?:acquired|learned|unlocked|upgraded|evolved)\b|quest\s+(?:complete(?:d)?|updated|failed|accepted|received)\b|new\s+(?:skill|title|quest|achievement|class)\b|achievement\s+(?:unlocked|earned)\b|title\s+(?:acquired|obtained|earned|granted)\b|you\s+have\s+(?:gained|obtained|acquired|learned|received|reached|leveled|levelled|slain|killed|defeated|earned|unlocked)\b)/i;

const HEADING = /^[\s[【<〈《]*(?:status(?:\s+(?:window|screen|panel))?|stats|character(?:\s+(?:sheet|status|info))?|attributes|skills|abilities|profile|inventory|equipment|titles|traits)[\s\]】>〉》:：]*$/i;

/** "Key: value" or "STR 12" (the key starts with a capital, up to four words; not "He said: …"). */
const STAT_LINE = /^[\s•·*\-–|]*([\p{Lu}][\p{L}'’ ./()-]{0,30}?|HP|MP|SP|EXP|XP)\s*(?:[:：=]\s*([^\s:：].{0,80}?)|\s+([+-]?\d[\d,./%() +×x-]*))\s*$/u;
const NOT_A_KEY = /^(?:he|she|it|they|i|we|you|the|a|an|and|but|then|so|this|that|there|here|what|why|how|when|where|who)\b/i;

/** Bracketed text that is a notice, not speech. */
export function isBracketedNotice(line: string): boolean {
  const m = BRACKETED.exec(line);
  if (!m) return false;
  if (OPEN.indexOf(m[1] ?? '') !== CLOSE.indexOf(m[3] ?? '')) return false;
  const inner = (m[2] ?? '').trim();
  if (!inner || /["“”]/.test(inner)) return false;
  if (SYSTEM_WORD.test(inner)) return true;
  if (SPEECHY.test(inner) || /[?]$/.test(inner)) return false;
  const words = inner.split(/\s+/);
  const capitalized = words.filter((w) => /^[\p{Lu}\d+-]/u.test(w)).length;
  // "[Shadow Step]", "[Blood Weave +2]": a short name, mostly capitalized, not a sentence.
  return words.length <= 6 && capitalized >= Math.ceil(words.length / 2) && !/[,;]/.test(inner);
}

export function isNotification(line: string): boolean {
  const t = line.trim();
  return t.length <= 200 && !/["“”]/.test(t) && NOTIFICATION.test(t);
}

/** A stat line's key and value ("Strength: 12" → {Strength, 12}); null if the line isn't one. */
export function parseStatLine(line: string): StatEntry | null {
  let t = line.trim();
  const br = BRACKETED.exec(t);
  if (br) t = (br[2] ?? '').trim();
  if (!t || t.length > 120 || /["“”]/.test(t)) return null;
  const m = STAT_LINE.exec(t);
  if (!m) return null;
  const key = (m[1] ?? '').trim();
  const value = (m[2] ?? m[3] ?? '').trim();
  if (!key || !value || NOT_A_KEY.test(key) || key.split(/\s+/).length > 4) return null;
  return { key, value };
}

export function isStatHeading(line: string): boolean {
  return HEADING.test(line.trim());
}

/** One block (not part of a stat table): is it a system message? */
export function isSystemBlock(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;
  let notice = false;
  for (const l of lines) {
    if (isBracketedNotice(l) || isNotification(l)) notice = true;
    else if (!(isStatHeading(l) || parseStatLine(l))) return false;
  }
  return notice;
}

type LineKind = 'heading' | 'stat' | 'other';

function lineKinds(text: string): LineKind[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (isStatHeading(l) ? 'heading' : parseStatLine(l) ? 'stat' : 'other'));
}

const KNOWN_KEY = /^(?:name|race|species|class|job|level|lv|lvl|rank|tier|title|age|hp|mp|sp|exp|xp|health|mana|stamina|strength|agility|dexterity|vitality|endurance|constitution|intelligence|wisdom|charisma|luck|perception|speed|spirit|willpower|str|agi|dex|vit|end|con|int|wis|cha|luk|per|spd|spi|skills?|titles?|points?|free points)\b/i;

/** Stat tables of a chapter (blocks not skipped by cleanup). */
export function findStatTables(blocks: readonly SourceBlock[], plans: readonly BlockPlan[]): StatTable[] {
  const tables: StatTable[] = [];
  let run: number[] = [];
  const close = (): void => {
    if (run.length === 0) return;
    const lines = run.flatMap((bi) => (blocks[bi]?.text ?? '').split('\n').filter((l) => l.trim()));
    const entries = lines.map(parseStatLine).filter((e): e is StatEntry => e !== null);
    const headingLine = lines.find((l) => isStatHeading(l));
    const numeric = entries.some((e) => /\d/.test(e.value));
    const known = entries.some((e) => KNOWN_KEY.test(e.key));
    if ((numeric || known) && (entries.length >= 3 || (headingLine !== undefined && entries.length >= 2))) {
      const table: StatTable = { blocks: run, entries };
      const heading = headingLine?.replace(/[[\]【】<>〈〉《》:：]/gu, '').trim();
      if (heading) table.heading = heading;
      tables.push(table);
    }
    run = [];
  };
  blocks.forEach((b, bi) => {
    const plan = plans[bi];
    if (!b.text.trim()) return;
    if (plan?.skip || plan?.separator || b.tag === 'hr') return close();
    const kinds = lineKinds(b.text);
    if (kinds.length > 0 && kinds.every((k) => k !== 'other') && kinds.includes('stat')) run.push(bi);
    else if (kinds.length === 1 && kinds[0] === 'heading' && run.length === 0) run.push(bi);
    else close();
  });
  close();
  return tables;
}

const IDENTITY = /^(?:name|true name|race|species|class|job|level|rank|tier|title|age|aspect|realm|cultivation)\b/i;
const ATTRIBUTE = /^(?:strength|agility|dexterity|vitality|endurance|constitution|intelligence|wisdom|charisma|luck|perception|speed|spirit|willpower|magic|defen[cs]e|attack|resistance|mind|power|soul|str|agi|dex|vit|end|con|int|wis|cha|luk|lck|per|spd|spi|wil|mag|def|atk|res)\b/i;
const RESOURCE = /^(?:hp|mp|sp|health|mana|stamina|essence|exp|xp|experience)\b/i;

/** Entries in a compact order: who (name, class, level…), attributes, resources, the rest. */
export function orderedEntries(entries: readonly StatEntry[]): StatEntry[] {
  const group = (e: StatEntry): number => (IDENTITY.test(e.key) ? 0 : ATTRIBUTE.test(e.key) ? 1 : RESOURCE.test(e.key) ? 2 : 3);
  return entries.map((e, i) => ({ e, i, g: group(e) })).sort((a, b) => a.g - b.g || a.i - b.i).map((x) => x.e);
}

/** How many entries the short summary reads. */
export const SHORT_ENTRIES = 6;

/** One entry, compact: "Strength 12" (numbers) or "Class: Shadow" (words). */
export function entryText(e: StatEntry): string {
  return /^[+-]?\d/.test(e.value) ? `${e.key} ${e.value}` : `${e.key}: ${e.value}`;
}

/** The short reading of a stat table: "Status. Name: Sunny, Level 5, Strength 12, … and 4 more." */
export function statSummary(t: StatTable): string {
  const usable = orderedEntries(t.entries).filter((e) => e.value.length <= 40);
  const read = usable.slice(0, SHORT_ENTRIES);
  const more = t.entries.length - read.length;
  const list = read.map(entryText).join(', ');
  return `${t.heading ?? 'Status'}. ${list}${more > 0 ? `, and ${more} more` : ''}.`;
}
