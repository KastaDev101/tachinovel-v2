/** Deterministic fixture text: novel titles, chapter titles and prose that reads like a web novel. */

export type Rng = () => number;

export function rng(seed: number): Rng {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pick<T>(r: Rng, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

export function int(r: Rng, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

const NAMES = ['Kael', 'Mira', 'Teodor', 'Lysa', 'Ren', 'Iskra', 'Doran', 'Vela', 'Corin', 'Ashe', 'Nim', 'Halvard'];
const PLACES = [
  'the Ashen Gate', 'the lower city', 'the drowned library', 'the northern ridge', 'the old lighthouse',
  'the market square', 'the bone orchard', 'the glass desert', 'the sunken stair', 'the watchtower',
  'the river road', 'the abandoned chapel',
];
const OBJECTS = [
  'the lantern', 'a rusted key', 'the map', 'her blade', 'the ledger', 'a cracked mirror', 'the letter',
  'his coat', 'the compass', 'a silver coin', 'the door', 'the shard',
];
const ADJ = [
  'quiet', 'cold', 'narrow', 'ancient', 'restless', 'pale', 'heavy', 'distant', 'hollow', 'bright',
  'crooked', 'endless', 'brittle', 'patient', 'grey', 'warm',
];
const NOUNS = ['wind', 'silence', 'rain', 'light', 'dark', 'fog', 'snow', 'smoke', 'dust', 'tide', 'stars', 'ash'];
const VERBS = [
  'studied', 'pocketed', 'lifted', 'turned over', 'ignored', 'remembered', 'traced', 'abandoned', 'counted',
  'examined', 'gripped', 'set down',
];
const FEELINGS = [
  'unable to shake a strange unease', 'more tired than ever', 'with a crooked smile', 'without a word',
  'as if nothing had happened', 'with deliberate care', 'holding back a sigh', 'listening to the silence',
];
const LINES = [
  'We don’t have much time.', 'Did you hear that?', 'Stay close to me, and don’t touch anything.',
  'I told you this was a bad idea.', 'If we keep walking, we’ll reach it before dawn.',
  'You knew. You knew all along, didn’t you?', 'It’s not a door. It’s a mouth.',
  'Then we do it the hard way.', 'Some promises are heavier than chains.', 'Wait. Something’s wrong.',
  'Nobody comes back from there.', 'Breathe. Count to ten. Then run.',
];
const TAGS = ['', ' quietly', ' after a pause', ', voice low', ' without looking up', ', almost laughing'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SENTENCES: ((r: Rng) => string)[] = [
  (r) => `${pick(r, NAMES)} ${pick(r, VERBS)} ${pick(r, OBJECTS)}, ${pick(r, FEELINGS)}.`,
  (r) => `${cap(pick(r, PLACES))} was ${pick(r, ADJ)} and ${pick(r, ADJ)}, and the ${pick(r, NOUNS)} carried a smell of ${pick(r, NOUNS)}.`,
  () => `For a long moment, nobody moved.`,
  (r) => `Somewhere beyond ${pick(r, PLACES)}, a bell rang once and fell silent.`,
  (r) => `${pick(r, NAMES)} had seen many strange things, but never anything quite like this.`,
  (r) => `The ${pick(r, NOUNS)} thickened, swallowing the path ahead until only the ${pick(r, ADJ)} outline of ${pick(r, PLACES)} remained.`,
  () => `It was not fear, exactly — more like the memory of fear, worn smooth by repetition.`,
  (r) => `${pick(r, NAMES)} counted the steps in silence: twelve, thirteen, fourteen.`,
  (r) => `There would be time to think later; right now, there was only ${pick(r, OBJECTS)} and the ${pick(r, ADJ)} ${pick(r, NOUNS)}.`,
  (r) => `${cap(pick(r, OBJECTS))} felt ${pick(r, ADJ)} in ${pick(r, NAMES)}'s hand, heavier than it had any right to be.`,
  (r) => `By the time they reached ${pick(r, PLACES)}, the ${pick(r, NOUNS)} had stopped and the sky had turned the color of old pewter.`,
  (r) => `${pick(r, NAMES)} glanced back once, but the road behind them was empty.`,
  (r) => `Every instinct said to turn around. ${pick(r, NAMES)} kept walking anyway.`,
  (r) => `The old stories never mentioned how ${pick(r, ADJ)} it would feel.`,
  (r) => `A gust of ${pick(r, NOUNS)} rolled across ${pick(r, PLACES)}, and somewhere a shutter banged against a wall.`,
  (r) => `${pick(r, NAMES)} let out a slow breath and pressed a palm against ${pick(r, OBJECTS)}.`,
  (r) => `Nothing about ${pick(r, PLACES)} had changed, and that, somehow, was the worst part.`,
  (r) => `Far below, the lights of the lower city flickered like ${pick(r, ADJ)} coals.`,
  (r) => `${pick(r, NAMES)} remembered the promise, and the price, and said nothing.`,
  () => `The silence stretched until it became a kind of answer.`,
  (r) => `Three days ago, ${pick(r, NAMES)} would have laughed at the idea. Now it seemed almost reasonable.`,
  (r) => `Under the ${pick(r, ADJ)} ${pick(r, NOUNS)}, the ruins looked smaller than they had from the ridge.`,
];

function sentence(r: Rng, avoid: Set<number>): string {
  let i = Math.floor(r() * SENTENCES.length);
  for (let guard = 0; avoid.has(i) && guard < 8; guard++) i = Math.floor(r() * SENTENCES.length);
  avoid.add(i);
  return (SENTENCES[i] ?? SENTENCES[0] ?? (() => ''))(r);
}

/** `avoid` carries recently used templates so neighbouring paragraphs don't repeat themselves. */
export function paragraph(r: Rng, avoid: Set<number> = new Set()): string {
  if (r() < 0.24) return `“${pick(r, LINES)}” ${pick(r, NAMES)} said${pick(r, TAGS)}.`;
  const n = int(r, 2, 5);
  const out: string[] = [];
  if (avoid.size > 12) avoid.clear();
  for (let i = 0; i < n; i++) out.push(sentence(r, avoid));
  return out.join(' ');
}

const T_ADJ = [
  'Shadow', 'Ember', 'Crimson', 'Silver', 'Hollow', 'Ashen', 'Starfall', 'Iron', 'Moonlit', 'Endless',
  'Gilded', 'Forgotten', 'Abyssal', 'Verdant', 'Frost', 'Storm', 'Sunken', 'Quiet',
];
const T_NOUN = [
  'Sovereign', 'Gate', 'Path', 'Throne', 'Archive', 'Covenant', 'Requiem', 'Odyssey', 'Library', 'Saint',
  'Tower', 'Chronicle', 'Heir', 'Wanderer', 'Blade', 'Garden', 'Lantern', 'Cartographer',
];
const T_JOB = ['Blacksmith', 'Librarian', 'Healer', 'Villain', 'Dungeon Keeper', 'Alchemist', 'Tamer', 'Lighthouse Keeper'];

export function novelTitle(r: Rng): string {
  switch (int(r, 0, 5)) {
    case 0:
      return `The ${pick(r, T_ADJ)} ${pick(r, T_NOUN)}`;
    case 1:
      return `${pick(r, T_ADJ)} ${pick(r, T_NOUN)}`;
    case 2:
      return `${pick(r, T_NOUN)} of the ${pick(r, T_ADJ)} ${pick(r, T_NOUN)}`;
    case 3:
      return `Reincarnated as a ${pick(r, T_JOB)}`;
    case 4:
      return `I Became the ${pick(r, T_NOUN)} of a ${pick(r, T_ADJ)} World`;
    default:
      return `The ${pick(r, T_JOB)}'s ${pick(r, T_NOUN)}`;
  }
}

const C_PATTERNS: ((r: Rng) => string)[] = [
  (r) => `The ${cap(pick(r, ADJ))} ${cap(pick(r, NOUNS))}`,
  (r) => `${cap(pick(r, NOUNS))} and ${cap(pick(r, NOUNS))}`,
  (r) => `${pick(r, NAMES)}`,
  (r) => `Beyond ${pick(r, PLACES).replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => sp + c.toUpperCase()).replace(/^The /, 'the ')}`,
  (r) => `A ${cap(pick(r, ADJ))} Bargain`,
  (r) => `What the ${cap(pick(r, NOUNS))} Remembers`,
  (r) => `${cap(pick(r, ADJ))} Hours`,
];

export function chapterTitle(seed: number, n: number): string {
  const r = rng(seed ^ (n * 2654435761));
  return `Chapter ${n}: ${pick(r, C_PATTERNS)(r)}`;
}

const AUTHORS = ['Wren Calder', 'J. T. Marrow', 'Ashen Quill', 'Tobias Rook', 'Inkwell', 'Selene Hart', 'R. K. Vale', 'Nightfox', 'Elena Mire', 'Hollowpen'];
export function authorName(r: Rng): string {
  return pick(r, AUTHORS);
}

const GENRES = ['Action', 'Adventure', 'Fantasy', 'Mystery', 'Drama', 'Dark Fantasy', 'Progression', 'Romance', 'Sci-fi', 'Slice of Life', 'Horror', 'Comedy', 'LitRPG', 'Psychological', 'Tragedy'];
export function genres(r: Rng): string[] {
  const out = new Set<string>();
  const n = int(r, 3, 6);
  while (out.size < n) out.add(pick(r, GENRES));
  return [...out];
}

export function summary(r: Rng, title: string): string {
  return [
    `Growing up in the poorest corner of the lower city, ${pick(r, NAMES)} never expected much from life — certainly not to survive the night the ${pick(r, ADJ)} ${pick(r, NOUNS)} came.`,
    `Now bound to ${title.replace(/^The /, 'the ')}, they must navigate a world of ancient oaths, ${pick(r, ADJ)} gods and people who smile too easily. Every step forward costs something. Every secret has a price.`,
    `A slow-burning story about survival, found family and the stubborn refusal to give up, updated three times a week.`,
  ].join('\n');
}
