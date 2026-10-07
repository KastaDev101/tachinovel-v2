/**
 * Text normalization for narration, table-driven (text prep, src/core/narration/prep). Every engine gets
 * the same words: Kokoro, Chatterbox and the Apple voice.
 *
 *   spoken text ──PRE_RULES──► v1 normalizeForSpeech ──POST_RULES──► words
 *
 * PRE_RULES need the raw text: money, clock times, years, decades, "10k", LitRPG ("Lv. 5", "STR +2",
 * "HP 50/100", skill ranks "Fireball II"), symbols. v1's normalizeForSpeech (the PC narrator's rules:
 * quotes, URLs, "…", dashes, brackets, emoji, stutters, "Ch. 12", Mr./Dr./St., ordinals, "Chapter IV",
 * "x2", "+10", "50%", "100/100", units, shouting) runs next and still sees digits. POST_RULES then say
 * every number left in words, so no engine has to guess ("1,000", "3.5", "MP5").
 *
 * Each rule carries its own examples (input → the whole normalizer's output); tests/narration-text.test.ts
 * runs them all. This is the SPOKEN text only: highlighting uses the source offsets of each segment, which
 * normalization never touches.
 */
import { normalizeForSpeech as v1Normalize, numberToWords, romanToInt } from '@v1tts/frontend.ts';
import { cardinalWords, decadeWords, decimalWords, fractionWords, moneyWords, scaledWords, timeWords, yearWords } from './numbers.ts';

export interface NormalizeContext {
  /** A LitRPG system message or status window (stat lines read compactly). */
  system?: boolean;
  /** Stutters ("W-what") dropped (default) or kept. */
  stutter?: 'drop' | 'keep';
}

type Replace = (g: string[], at: { input: string; offset: number }) => string;

export interface Rule {
  id: string;
  re: RegExp;
  to: string | Replace;
  /** Cheap test first: the rule only runs when the text matches (speed: most sentences have no digits). */
  gate?: RegExp;
  /** Only in system messages / status windows. */
  system?: boolean;
  /** Input → output of the whole normalizer (normalizeSpeech), in the rule's context. */
  examples: [string, string][];
}

/** II … XX, longest first (the pronoun "I" is never one). */
const ROMAN = 'XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II';
/** Ranks after a name: the same without a lone "X" ("Project X" stays a letter). */
const ROMAN_RANK = ROMAN.replace('|X|', '|');
/** Money amounts: "1,250", "5.50", "5". */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/** Skill/item words a Roman numeral rank follows ("Fireball II" is "Fireball two", not "the Second"). */
const SKILL_NOUNS =
  'Fireball|Firebolt|Slash|Strike|Step|Arrow|Bolt|Shield|Blade|Mastery|Boost|Aura|Potion|Sword|Spear|Bow|Armou?r|Ring|Scroll|Skill|Spell|Technique|Art|Form|Stance|Barrier|Heal|Healing|Blast|Wave|Burst|Storm|Lance|Edge|Punch|Kick|Sense|Sight|Body|Mind|Soul|Rune|Core|Seed|Domain|Regeneration|Resistance|Affinity|Manipulation|Control|Enhancement|Reinforcement';

/** Stat abbreviations: always expanded when written in capitals. */
const STATS_ALWAYS: Record<string, string> = {
  STR: 'Strength', AGI: 'Agility', DEX: 'Dexterity', VIT: 'Vitality', INT: 'Intelligence', WIS: 'Wisdom', LUK: 'Luck',
  LCK: 'Luck', SPD: 'Speed', ATK: 'Attack', MATK: 'Magic Attack', MDEF: 'Magic Defense', CRIT: 'Critical', EVA: 'Evasion',
  ACC: 'Accuracy', STA: 'Stamina',
};
/** Ambiguous in capitals ("THE END"): expanded only next to a number ("END: 12", "+3 END"). */
const STATS_WITH_NUMBER: Record<string, string> = {
  END: 'Endurance', CON: 'Constitution', PER: 'Perception', RES: 'Resistance', MAG: 'Magic', SPI: 'Spirit', WIL: 'Willpower',
  DEF: 'Defense', CHA: 'Charisma', MND: 'Mind', POW: 'Power',
};
/** Points read letter by letter, the way LitRPG readers say them. */
const LETTERED = ['HP', 'MP', 'SP', 'XP', 'EXP', 'Exp', 'exp', 'AP', 'CP', 'DP', 'SSS', 'SS'];

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

/** Index of the end of the match in `input`. */
const endOf = (g: string[], at: { offset: number }): number => at.offset + (g[0]?.length ?? 0);

function romanCardinal(r: string): string | null {
  const v = romanToInt(r);
  return v === null ? null : String(v);
}

function expandStats(text: string): string {
  return text
    .replace(new RegExp(`(?<![\\p{L}\\d])(${Object.keys(STATS_ALWAYS).join('|')})(?![\\p{L}\\d])`, 'gu'), (m: string) => STATS_ALWAYS[m] ?? m)
    .replace(
      new RegExp(`(?<![\\p{L}\\d])(${Object.keys(STATS_WITH_NUMBER).join('|')})(?![\\p{L}\\d])(?=\\s*[:：=]?\\s*[+-]?\\d)|(?<=[+-]?\\d\\s?)(${Object.keys(STATS_WITH_NUMBER).join('|')})(?![\\p{L}\\d])`, 'gu'),
      (m: string) => STATS_WITH_NUMBER[m] ?? m,
    );
}

export const PRE_RULES: Rule[] = [
  { id: 'spaced-dots', re: /(?:\.[ \u00A0]){2,}\./g, gate: /\. \./, to: '…', examples: [['Wait. . . what?', 'Wait… what?']] },
  {
    id: 'tilde-range',
    re: /(\d)\s*[~～〜]\s*(\d)/g,
    gate: /[~～〜]/,
    to: '$1 to $2',
    examples: [['It takes 3~5 days.', 'It takes three to five days.']],
  },
  {
    id: 'currency',
    re: new RegExp(String.raw`([$£€¥₩₹])\s?(${AMOUNT})(?:\s?(k|K|M|bn|thousand|million|billion|trillion)(?![\p{L}\d]))?`, 'gu'),
    gate: /[$£€¥₩₹]/,
    to: (g) => moneyWords(g[1] ?? '', g[2] ?? '', g[3] || undefined),
    examples: [
      ['It cost $5.', 'It cost five dollars.'],
      ['Just $1 more.', 'Just one dollar more.'],
      ['That is $5.50 each.', 'That is five dollars and fifty cents each.'],
      ['Only $0.99!', 'Only ninety-nine cents!'],
      ['A $1.5 million bounty.', 'A one point five million dollars bounty.'],
      ['He paid £20 and €10k.', 'He paid twenty pounds and ten thousand euros.'],
      ['It was ¥500.', 'It was five hundred yen.'],
      ['The bill: $1,250.', 'The bill: one thousand two hundred and fifty dollars.'],
    ],
  },
  {
    id: 'currency-after',
    re: new RegExp(String.raw`(?<![\p{L}\d.,])(${AMOUNT})\s?([$£€¥₩₹])(?![\d])`, 'gu'),
    gate: /\d\s?[$£€¥₩₹]/,
    to: (g) => moneyWords(g[2] ?? '', g[1] ?? ''),
    examples: [['It sold for 500$.', 'It sold for five hundred dollars.']],
  },
  {
    id: 'time-ampm',
    re: /(?<![\d:])(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([AaPp])\.?\s?([Mm])(\.?)(?![\p{L}\d])/gu,
    gate: /\d\s?[AaPp]\.?\s?[Mm]/,
    to: (g, at) => {
      const words = timeWords(Number(g[1]), Number(g[2] || '0'), (g[3] ?? '').toUpperCase() === 'A' ? 'AM' : 'PM');
      // "at 5 p.m." ending the sentence keeps its full stop; "5 p.m. sharp" doesn't get one.
      const after = at.input.slice(endOf(g, at));
      return g[5] && (after === '' || /^\s+["'”’]?\p{Lu}/u.test(after)) ? `${words}.` : words;
    },
    examples: [
      ['We left at 5pm.', 'We left at five PM.'],
      ['Meet me at 7:45 a.m. sharp.', 'Meet me at seven forty-five AM sharp.'],
      ['It started at 9 p.m. Nobody came.', 'It started at nine PM. Nobody came.'],
    ],
  },
  {
    id: 'time',
    re: /(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g,
    gate: /\d:\d\d/,
    to: (g) => {
      const h = Number(g[1]);
      const m = Number(g[2]);
      return (h >= 13 || h === 0) && m === 0 ? `${numberToWords(h)} hundred` : timeWords(h, m);
    },
    examples: [
      ['At 3:30 the bell rang.', 'At three thirty the bell rang.'],
      ['It was 10:05.', 'It was ten oh five.'],
      ['Wake up at 12:00.', "Wake up at twelve o'clock."],
      ['The gate opens at 14:00.', 'The gate opens at fourteen hundred.'],
    ],
  },
  {
    id: 'year-era',
    re: /(?<![\d,.])(\d{3,4})\s?(AD|BC|BCE|CE)(?![\p{L}\d])/gu,
    gate: /\d\s?(?:AD|BC|CE)/,
    to: (g) => `${yearWords(Number(g[1]))} ${[...(g[2] ?? '')].join(' ')}`,
    examples: [['Rome, 753 BC.', 'Rome, seven hundred and fifty-three B C.']],
  },
  {
    id: 'year',
    re: new RegExp(`\\b(in|In|since|Since|until|Until|till|circa|year|Year|summer|Summer|winter|Winter|spring|Spring|autumn|Autumn|fall|${MONTHS})(,?\\s+(?:of\\s+)?)(1[1-9]\\d\\d|20\\d\\d)(?![\\d,.]\\d|\\d|s\\b|\\s*(?:%|percent))`, 'g'),
    gate: /\b(?:1[1-9]|20)\d\d\b/,
    to: (g) => `${g[1] ?? ''}${g[2] ?? ''}${yearWords(Number(g[3]))}`,
    examples: [
      ['Back in 1999, it rained.', 'Back in nineteen ninety-nine, it rained.'],
      ['Since 2026 nothing changed.', 'Since twenty twenty-six nothing changed.'],
      ['It was May 1905.', 'It was May nineteen oh five.'],
      ['He had 1999 coins.', 'He had one thousand nine hundred and ninety-nine coins.'],
    ],
  },
  {
    id: 'decade',
    re: /(?<![\p{L}\d'’])['’]?((?:1[1-9]|20)\d0|[1-9]0)s(?![\p{L}\d])/gu,
    gate: /\d0s/,
    to: (g) => decadeWords(g[1] ?? ''),
    examples: [
      ['Music from the 1990s.', 'Music from the nineteen nineties.'],
      ["Back in the '80s.", 'Back in the eighties.'],
      ['A man in his 40s.', 'A man in his forties.'],
    ],
  },
  {
    id: 'level',
    re: new RegExp(String.raw`(?<![\p{L}\d])(?:Lv|LV|Lvl|LVL|lvl|lv)(?:\.\s*|\s*)(?=\d|max\b|MAX\b|(?:${ROMAN}|I)\b)`, 'gu'),
    gate: /(?:Lv|LV|lv)/,
    to: 'Level ',
    examples: [
      ['He reached Lv. 5 today.', 'He reached Level five today.'],
      ['A Lvl 12 wolf.', 'A Level twelve wolf.'],
      ['The LV30 boss.', 'The Level thirty boss.'],
    ],
  },
  { id: 'level-max', re: /\bLevel\s+MAX\b/g, gate: /MAX/, to: 'Level max', examples: [['Skill: Lv. MAX', 'Skill: Level max']] },
  {
    id: 'stats',
    re: /^[\s\S]+$/g,
    gate: /[A-Z]{3}/,
    to: (g) => expandStats(g[0] ?? ''),
    examples: [
      ['He put 5 points into STR.', 'He put five points into Strength.'],
      ['+3 AGI and +2 END', 'plus three Agility and plus two Endurance'],
      ['THE END', 'THE END'],
    ],
  },
  {
    id: 'points',
    re: new RegExp(`(?<![\\p{L}\\d])(?:${LETTERED.join('|')})(?![\\p{L}\\d])`, 'gu'),
    gate: /(?:HP|MP|SP|XP|EXP|Exp|exp|AP|CP|DP|SS)/,
    to: (g) => [...(g[0] ?? '').toUpperCase()].join(' '),
    examples: [
      ['His HP dropped to 50/120.', 'His H P dropped to fifty out of one hundred and twenty.'],
      ['Gained 300 EXP.', 'Gained three hundred E X P.'],
      ['An SSS-rank talent.', 'An S S S-rank talent.'],
    ],
  },
  {
    id: 'stat-colon',
    system: true,
    re: /^(\s*\p{L}[\p{L} ]{0,28}?)\s*[:：=]\s*(?=[+-]?\d)/gmu,
    gate: /[:：=]\s*[+-]?\d/,
    to: '$1 ',
    examples: [
      ['Strength: 12', 'Strength twelve'],
      ['STR: 12 (+2)', 'Strength twelve (plus two)'],
    ],
  },
  {
    id: 'plus-attached',
    re: /(?<=[\p{L})\]])\s*\+(?=\s?\d)|(?<=\d)\+(?![\d])/gu,
    gate: /\+/,
    to: ' plus ',
    examples: [
      ['A Sword+5 lay there.', 'A Sword plus five lay there.'],
      ['Level 20+ monsters.', 'Level twenty plus monsters.'],
    ],
  },
  {
    id: 'scale',
    re: /(?<![\p{L}\d.,$£€¥₩₹])(\d+(?:\.\d+)?)(k|K|M|bn)(?![\p{L}\d])/gu,
    gate: /\d(?:k|K|M|bn)/,
    to: (g) => scaledWords(g[1] ?? '', g[2] ?? ''),
    examples: [
      ['He had 10k followers.', 'He had ten thousand followers.'],
      ['A 2.5M bounty.', 'A two point five million bounty.'],
    ],
  },
  {
    id: 'fraction-symbol',
    re: /(\d)?\s?([½¼¾⅓⅔])/g,
    gate: /[½¼¾⅓⅔]/,
    to: (g) => {
      const name = { '½': ['one half', 'a half'], '¼': ['one quarter', 'a quarter'], '¾': ['three quarters', 'three quarters'], '⅓': ['one third', 'a third'], '⅔': ['two thirds', 'two thirds'] }[g[2] ?? ''] ?? ['', ''];
      return g[1] ? `${g[1]} and ${name[1]}` : ` ${name[0]}`;
    },
    examples: [['It took 2½ hours.', 'It took two and a half hours.']],
  },
  {
    id: 'fraction',
    re: /(?<![\d/.,])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
    gate: /\d\/\d/,
    to: (g) => {
      const n = Number(g[1]);
      const d = Number(g[2]);
      if (n === 24 && d === 7) return 'twenty-four seven';
      return n > 0 && n < d && d <= 12 ? fractionWords(n, d) : (g[0] ?? '');
    },
    examples: [
      ['Only 1/2 of them.', 'Only one half of them.'],
      ['About 3/4 done.', 'About three quarters done.'],
      ['He trained 24/7.', 'He trained twenty-four seven.'],
    ],
  },
  {
    id: 'degrees',
    re: /(\d)\s?°\s?([CF])?(?![\p{L}])/gu,
    gate: /°/,
    to: (g) => `${g[1] ?? ''} degrees${g[2] === 'C' ? ' Celsius' : g[2] === 'F' ? ' Fahrenheit' : ''}`,
    examples: [
      ['It was 30°C outside.', 'It was thirty degrees Celsius outside.'],
      ['Turn 90° left.', 'Turn ninety degrees left.'],
    ],
  },
  { id: 'times-sign', re: /\s?×\s(?=\d)/g, gate: /×/, to: ' times ', examples: [['Damage × 3!', 'Damage times three!']] },
  {
    id: 'roman-skill',
    re: new RegExp(`\\b(${SKILL_NOUNS})\\s+(${ROMAN})(?![\\p{L}'’])`, 'gu'),
    gate: /[IVX]{2}|\bV\b|\bX\b/,
    to: (g) => `${g[1] ?? ''} ${romanCardinal(g[2] ?? '') ?? g[2] ?? ''}`,
    examples: [
      ['He cast Fireball II at it.', 'He cast Fireball two at it.'],
      ['Louis XIV smiled.', 'Louis the fourteenth smiled.'],
      ['Then I said no.', 'Then I said no.'],
    ],
  },
  {
    // Inside [brackets] and in system messages a Roman numeral after a name is a rank: "[Shadow Step III]".
    id: 'roman-bracket',
    re: /[[【<〈《][^\]】>〉》\n]{1,120}[\]】>〉》]/gu,
    gate: /[IVX]/,
    to: (g) => romanRanks(g[0] ?? ''),
    examples: [['[Shadow Step III] acquired.', 'Shadow Step three acquired.']],
  },
  {
    id: 'roman-system',
    system: true,
    re: /^[\s\S]*$/g,
    gate: /[IVX]/,
    to: (g) => romanRanks(g[0] ?? ''),
    examples: [['Skill acquired: Blood Weave II', 'Skill acquired: Blood Weave two']],
  },
  {
    id: 'symbols',
    re: /(?:[\u00A9\u00AE\u2122\u2020\u2021\u00A7\u00B6\u203B\u2500-\u27BF]|\uFE0E|\uFE0F|\u20E3)+/g,
    gate: /[\u00A9\u00AE\u2122\u2020\u2021\u00A7\u00B6\u203B\u2500-\u27BF]|\uFE0E|\uFE0F|\u20E3/,
    to: ' ',
    examples: [
      ['Done ✓ and ✔.', 'Done and.'],
      ['※ Warning ※', 'Warning'],
      ['TachiCorp™ sword ⚔ ready', 'TachiCorp sword ready'],
    ],
  },
  { id: 'aka', re: /\ba\.k\.a\.?/gi, gate: /a\.k\.a/i, to: 'also known as', examples: [['Sunny, a.k.a. the Lost', 'Sunny, also known as the Lost']] },
  { id: 'without', re: /\bw\/o\b/gi, gate: /w\/o/i, to: 'without', examples: [['Tea w/o sugar.', 'Tea without sugar.']] },
];

/** Roman numerals after a capitalized word, as cardinals ("Step III" → "Step 3"); a lone "I" only before punctuation. */
function romanRanks(s: string): string {
  return s.replace(new RegExp(`(\\p{Lu}[\\p{L}'’-]*)\\s+(${ROMAN_RANK}|I(?=\\s*(?:$|[\\]】>〉》),.:;!?])))(?![\\p{L}'’])`, 'gu'), (m: string, word: string, r: string) => {
    const v = romanCardinal(r);
    return v === null ? m : `${word} ${v}`;
  });
}

export const POST_RULES: Rule[] = [
  {
    id: 'letters-digits',
    re: /(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/gu,
    gate: /\p{L}\d|\d\p{L}/u,
    to: ' ',
    examples: [
      ['He drew his MP5.', 'He drew his MP five.'],
      ['A 3D map.', 'A three D map.'],
    ],
  },
  {
    id: 'version',
    re: /(?<![\d.])\d+(?:\.\d+){2,}(?![\d])/g,
    gate: /\d\.\d+\.\d/,
    to: (g) => (g[0] ?? '').split('.').map((p) => cardinalWords(p)).join(' point '),
    examples: [['Patch 1.2.3 is out.', 'Patch one point two point three is out.']],
  },
  {
    id: 'grouped',
    re: /(?<![\d.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d])/g,
    gate: /\d,\d{3}/,
    to: (g) => {
      const raw = (g[0] ?? '').replace(/,/g, '');
      return raw.includes('.') ? decimalWords(raw) : cardinalWords(raw);
    },
    examples: [
      ['There were 1,000 of them.', 'There were one thousand of them.'],
      ['It weighs 12,345.5 tons.', 'It weighs twelve thousand three hundred and forty-five point five tons.'],
    ],
  },
  {
    id: 'decimal',
    re: /(?<![\d.])\d+\.\d+(?!\d|\.\d)/g,
    gate: /\d\.\d/,
    to: (g) => decimalWords(g[0] ?? ''),
    examples: [
      ['Pi is 3.14.', 'Pi is three point one four.'],
      ['A 0.5 chance.', 'A zero point five chance.'],
    ],
  },
  {
    id: 'number',
    re: /\d+/g,
    gate: /\d/,
    to: (g) => cardinalWords(g[0] ?? ''),
    examples: [
      ['Chapter 12 had 304 pages.', 'Chapter twelve had three hundred and four pages.'],
      ['Agent 007.', 'Agent zero zero seven.'],
      ['Floor 3-5.', 'Floor three to five.'],
      ['Took 21st place.', 'Took twenty-first place.'],
    ],
  },
];

function run(rules: readonly Rule[], input: string, ctx: NormalizeContext): string {
  let s = input;
  for (const rule of rules) {
    if (rule.system && !ctx.system) continue;
    if (rule.gate && !rule.gate.test(s)) continue;
    const to = rule.to;
    if (typeof to === 'string') {
      s = s.replace(rule.re, to);
      continue;
    }
    s = s.replace(rule.re, (...args: unknown[]) => {
      // replace() passes match, groups…, offset, input[, named groups].
      let k = args.length - 1;
      if (typeof args[k] === 'object' && args[k] !== null) k--;
      const last = args[k];
      const before = args[k - 1];
      const input2 = typeof last === 'string' ? last : s;
      const offset = typeof before === 'number' ? before : 0;
      const groups = args.slice(0, k - 1).map((a) => (typeof a === 'string' ? a : ''));
      return to(groups, { input: input2, offset });
    });
  }
  return s;
}

/** Spoken text in words: PRE_RULES → v1's normalizer → POST_RULES. */
export function normalizeSpeech(input: string, ctx: NormalizeContext = {}): string {
  let s = run(PRE_RULES, input, ctx);
  s = v1Normalize(s, { stutter: ctx.stutter ?? 'drop' });
  s = run(POST_RULES, s, ctx);
  return s.replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').trim();
}

