/**
 * Natural delivery for the expressive narrator (Chatterbox Nano), the script side: the "director" pass, the
 * synthesis parameters it implies and the natural pauses. Pure ES2023 (core and UI), deterministic, well under
 * 1 ms per sentence. Everything text-side lives here, data-driven (the tables below), so tuning ships as a
 * signed web update; native (HDVoiceCore Delivery.swift) only applies the numbers (clamped), the audio chain,
 * breaths and crossfades. The displayed text is never changed: only `say`, the text Nano reads, is reshaped,
 * so the reader's highlighting (block offsets) stays exact.
 *
 * Kasta's listening test on the PC (round 8, narrator repo): feeding Chatterbox Nano whole sentences with
 * varied pauses (test A) beat phrase-by-phrase feeding, and A + a director (test B) was "much better".
 *
 *  - Mood: from dialogue tags and beats ("she whispered / snapped / laughed / sighed"), "!", a trailing "…",
 *    a few tense action words; LitRPG system messages get a crisp, slightly faster, even read. Moods are
 *    smoothed over a short window inside a scene (reset at scene breaks, POV headers and blank-line
 *    separators) so the tone doesn't flip line to line; a dialogue tag still wins for its line.
 *  - Line class on top of the mood (the narrator persona: confident, warm, playful): narration, plain
 *    dialogue (a little more animated than narration, same voice), teasing (teased/smirked/purred/hummed,
 *    "Hmm", "Oh", ellipses, a playful question), commanding (imperatives, "ordered", a short "Now."), tender
 *    (endearments, comfort, "gently"). A class brings its own pitch (varispeed: pitch and pace move together, no
 *    artifacts), gain, a falling ending for commands, a pause before the key word and room after a command.
 *  - Emphasis: italics/bold (<em>, <i>, <strong>, <b>), ALL CAPS words and sound effects ("BOOM!", "Crack—")
 *    get stress through the controls Nano has: a little gain, a short pause before a sound effect, the text
 *    reshaped so Nano neither spells nor shouts it. Never more than +1.2 dB.
 *  - Non-verbals (chuckle, light laugh, "hm", "mm"): never Nano's tags (they sounded robotic and roughened the
 *    speech after them). The director picks the type, sparingly and never the same twice in a row; native splices a
 *    recorded snippet from the voice's own pack in front of the line (none without a pack).
 *  - Pauses: a context model (what the sentence hands over to: the same speaker, narration, a switch between
 *    narration and dialogue, a new paragraph, a command) with ±10 % variation seeded by the sentence, ×1.2 after
 *    "…" inside a paragraph, ×0.85 after an intense line.
 *  - Breath groups: the narrator voice reads a paragraph per call (chunks), which sounds more connected than sentence by sentence.
 * On iOS 26 native can refine the moods ahead of playback with Apple's on-device model (MOOD_TABLE travels with
 * the script so the parameters follow the refined mood); these rules stay the fallback and never wait for it.
 * No imports on purpose: the Voice Lab samples (and the CI benchmark fixtures built from them with plain Node, no
 * alias resolver) use this file too. System messages are the segments text prep marks 'system' (segment.ts
 * NarrationSegment.kind; the front-end's SpeechItem.kind).
 */

export const MOODS = ['calm', 'soft', 'sad', 'tense', 'playful', 'intense', 'whisper', 'system'] as const;
export type Mood = (typeof MOODS)[number];
export const LINE_CLASSES = ['narration', 'dialogue', 'teasing', 'commanding', 'tender'] as const;
export type LineClass = (typeof LINE_CLASSES)[number];
/** Non-verbal snippets a voice pack can carry (native splices one in front of a line). */
export const NON_VERBALS = ['chuckle', 'laugh', 'hm', 'mm'] as const;
export type NonVerbal = (typeof NON_VERBALS)[number];
/** A stressed word (italics, bold, ALL CAPS), a whole italic sentence (a thought), or a sound effect. */
export type Stress = 'word' | 'thought' | 'sfx';

export interface Cue {
  mood: Mood;
  /** The sentence is (mostly) inside quotation marks. */
  dialogue: boolean;
  /** Narration, plain dialogue, or one of the persona's classes. Default: from `dialogue`. */
  line?: LineClass;
  /** The mood comes from a dialogue tag, a beat or markup: scene smoothing leaves it alone. */
  explicit?: boolean;
  /** A non-verbal in front of the line (dialogue only, sparingly). */
  nv?: NonVerbal;
  stress?: Stress;
  /** The word to pause before (the italic word, else the last content word), when this line gets one. */
  keyWord?: string;
  /** The sentence has an ellipsis (reads a touch slower). */
  ellipsis?: boolean;
  /** Narration that settles ("Luckily, …"): scene tension doesn't carry into it. */
  settled?: boolean;
}

/** What the director needs to know about one sentence, in script order. */
export interface DirectorSentence {
  block: number;
  kind: 'title' | 'text' | 'system';
  /** The sentence as the reader shows it. */
  display: string;
  /** The words outside quotation marks ('' for a sentence that is all dialogue). */
  narration: string;
  /** The words inside quotation marks ('' for narration). */
  speech?: string;
  /** Share of the letters inside quotation marks (0…1). */
  dialogueShare: number;
  /** The first sentence of a new scene (after a scene break, a title, a POV header, blank lines). */
  sceneStart?: boolean;
  /** A character's thought ('…' in a chapter quoting speech with “…”): never teasing, it isn't said to anyone. */
  thought?: boolean;
}

// ================================================================ the tables (tune here)

export interface MoodParams {
  /** Nano sampling temperature. */
  t: number;
  /** Gain, dB (after per-sentence loudness matching). */
  g: number;
  /** Tempo factor (1 = as rendered). */
  s: number;
}

/**
 * Mood → Nano's controls. Temperatures are the approved round-8 test-B table (round8.json approvedSpec): calm,
 * sad and whisper 0.70; warm/tender/hesitant 0.75 (soft); firm/curious 0.80 (tense); amused/teasing/playful 0.85;
 * intense/excited 0.90. Gain and tempo follow the same labels' intensity, kept within ±1.2 dB and 0.97–1.01.
 * Native uses this table to follow a mood the on-device model refined.
 */
export const MOOD_TABLE: Readonly<Record<Mood, MoodParams>> = {
  calm: { t: 0.7, g: 0, s: 1 },
  soft: { t: 0.75, g: -0.6, s: 0.99 },
  sad: { t: 0.7, g: -0.6, s: 0.99 },
  tense: { t: 0.8, g: 0.6, s: 1.01 },
  playful: { t: 0.85, g: 0.6, s: 1.01 },
  intense: { t: 0.9, g: 1.2, s: 1.01 },
  whisper: { t: 0.7, g: -1.2, s: 0.98 },
  // LitRPG system messages: crisp, slightly faster, even.
  system: { t: 0.7, g: 0, s: 1.04 },
};
/** A sentence with "…" reads a touch slower (approved test B: ×0.97). */
export const ELLIPSIS_TEMPO = 0.97;

export interface ClassParams {
  /** Tempo multiplier (time-stretch, pitch kept; within TEMPO_LIMITS). */
  tempo: number;
  /** Varispeed in cents: pitch and pace move together (−40 ≈ 2.3 % slower, −60 ≈ 3.5 %), no stretching artifacts. */
  cents: number;
  /** Gain, dB (replaces the plain-dialogue lift). */
  g: number;
  /** Extra silence after the line, ms at 1.0×. */
  pauseAfterMs?: number;
  /** "!" → "." in the text Nano reads (a falling, settled ending). */
  fallingEnd?: boolean;
  /** Pause before the key word, written into the text Nano reads ("…" ≈ 250 ms, "," ≈ 150 ms). */
  keyWordPause?: '…' | ',';
  /** The mood this class reads in, unless a tag said otherwise. */
  mood?: Mood;
}

/** Line classes (values from the persona round; round8.json carries the final numbers). */
export const CLASS_TABLE: Readonly<Record<LineClass, ClassParams>> = {
  narration: { tempo: 1, cents: 0, g: 0 },
  dialogue: { tempo: 1, cents: 0, g: 0.5 },
  teasing: { tempo: 1, cents: -40, g: 0, keyWordPause: '…', mood: 'playful' },
  // Quiet authority: lower, slower, softer, settled endings, room after.
  commanding: { tempo: 1, cents: -60, g: -1, pauseAfterMs: 300, fallingEnd: true, keyWordPause: ',', mood: 'calm' },
  tender: { tempo: 0.98, cents: 0, g: -0.4, mood: 'soft' },
};

/** Inside quotation marks the temperature lifts a little (plain dialogue's gain lift is in CLASS_TABLE), never
 * past 0.85 (or the mood's own temperature, when that is higher). */
export const DIALOGUE_LIFT_T = 0.05;
const DIALOGUE_LIFT_CAP = 0.85;
/** Stress (italics, bold, caps, sound effects) and thoughts (a whole italic sentence: a little softer). */
export const STRESS_LIFT = { word: { t: 0.02, g: 0.4, s: 0.99 }, thought: { t: 0, g: -0.4, s: 0.99 }, sfx: { t: 0.03, g: 0.5, s: 1 } } as const;
/** Silence before a sound effect (ms at 1.0×). */
export const SFX_PRE_PAUSE_MS = 150;
/** Overall tempo on top of everything. 1: the approved test-B values have none (a 0.95 round was rejected). */
export const NATURAL_TEMPO = 1;
/** Bounds (never shout, never drag): the approved table's 0.70–0.90. */
export const TEMPERATURE_RANGE = [0.7, 0.9] as const;
export const GAIN_RANGE_DB = [-1.2, 1.2] as const;
/** The mood's own tempo range ("…" ×0.97 on top). Any line's stretch stays within ±4 % (TEMPO_LIMITS): more
 * smears Nano's voice (measured on Kasta's clips); bigger contrast comes from pauses, gain and falling endings. */
export const TEMPO_RANGE = [0.97, 1.01] as const;
export const TEMPO_LIMITS = [0.96, 1.04] as const;
export const CENTS_RANGE = [-100, 100] as const;
/** Per-line pitch (CLASS_TABLE cents) by varispeed (plain resampling: pitch and pace together, no smear; a
 * pitch shift that kept the pace added smear and was dropped). */
export const PER_LINE_PITCH = true;

/** At most one sound tag in this many sentences, and a teasing [chuckle] once per this many teasing lines. */
export const MIN_TAG_GAP = 6;
export const TEASING_CHUCKLE_EVERY = 6;
/** At most one key-word pause in this many sentences (so it stays a gesture, not a tic). */
export const KEY_WORD_GAP = 3;
/** A stressed italic word gets a pause before it too. */
export const STRESS_KEY_WORD_PAUSE: ClassParams['keyWordPause'] = '…';
/** Dialogue: a sentence with at least this share of its letters inside quotation marks. */
export const DIALOGUE_SHARE = 0.5;
/** Scene mood: sentences on each side that vote, and the weight of the sentence's own label (dialogue keeps its
 * punctuation unless three neighbours agree otherwise; narration follows two). */
export const SCENE_WINDOW = 2;
const OWN_VOTE = { narration: 1.5, dialogue: 2.5 } as const;

/** Dialogue tags and beats → mood (+ a non-verbal), checked in this order; the first match wins. */
const MOOD_RULES: readonly [Mood, NonVerbal | undefined, RegExp][] = [
  ['whisper', undefined, /\b(?:whisper(?:ed|s|ing)?|murmur(?:ed|s|ing)?|breathed|hushed|under (?:his|her|their|my|its) breath)\b/i],
  [
    'intense',
    undefined,
    /\b(?:shout(?:ed|s|ing)?|yell(?:ed|s|ing)?|scream(?:ed|s|ing)?|shriek(?:ed|s|ing)?|roar(?:ed|s|ing)?|bellow(?:ed|s|ing)?|snap(?:ped|s)?|bark(?:ed|s)?|growl(?:ed|s|ing)?|snarl(?:ed|s|ing)?|hiss(?:ed|es|ing)?|spat|thunder(?:ed|s)|angrily|furiously|coldly|sharply)\b/i,
  ],
  ['tense', undefined, /\b(?:gasp(?:ed|s|ing)?)\b/i],
  ['tense', undefined, /\b(?:stammer(?:ed|s|ing)?|stutter(?:ed|s|ing)?|trembl(?:ed|es|ing)|nervously|hesitantly|warily|urgently|panick(?:ed|ing)|blurted)\b/i],
  ['sad', undefined, /\b(?:sigh(?:ed|s|ing)?)\b/i],
  ['sad', undefined, /\b(?:sob(?:bed|s|bing)?|cried|crying|weep(?:s|ing)?|wept|whimper(?:ed|s|ing)?|sniffl(?:ed|es|ing)|sadly|mournfully|miserably)\b/i],
  ['playful', 'laugh', /\b(?:laugh(?:ed|s|ing)?|cackl(?:ed|es|ing))\b/i],
  ['playful', 'chuckle', /\b(?:chuckl(?:ed|es|ing)|giggl(?:ed|es|ing)|snicker(?:ed|s|ing)|grinn(?:ed|ing)|grins|jok(?:ed|es|ing)|winked|mischievously)\b/i],
  ['soft', undefined, /\b(?:softly|gently|quietly|tenderly|kindly|soothingly)\b/i],
];

/** Line classes from the attribution or beat ("she purred", "he ordered"); these win over the words. */
const CLASS_TAG_RULES: readonly [LineClass, RegExp][] = [
  ['commanding', /\b(?:order(?:ed|s)|command(?:ed|s)|instruct(?:ed|s)|demand(?:ed|s))\b/i],
  ['teasing', /\b(?:teas(?:ed|es|ing)|smirk(?:ed|s|ing)|purr(?:ed|s|ing)|hum(?:med|s)|teasingly|playfully|coyly|slyly|sneer(?:ed|s|ing)?|mock(?:ed|s|ing)|gloat(?:ed|s|ing)?|taunt(?:ed|s|ing)?|jeer(?:ed|s|ing)?|scoff(?:ed|s|ing)?)\b/i],
  ['tender', /\b(?:gently|tenderly|soothingly|warmly|lovingly|kindly|softly)\b/i],
];

/** Words that open an order ("Come here.", "Don't move."). */
const IMPERATIVE =
  /^(?:come|go|get|stop|sit|stand|look|listen|give|take|stay|hold|run|wait|kneel|open|close|leave|follow|tell|show|bring|put|don'?t|do|be|let|move|drop|answer|speak|eat|drink|sleep|rest|breathe|focus|remember|forget|keep|turn|watch|hurry|calm|relax|shut|step|lie|lay|undress|kiss|beg|say|try|now|enough|again|quiet|silence|down|up|out|here|hands|eyes|back)\b/i;
/** Endearments and comfort. */
const TENDER_SPEECH = /\b(?:dear|darling|sweetheart|sweetie|honey|my love|little one|it'?s (?:okay|ok|alright|all right)|i'?m here|don'?t cry|shh+|hush)\b/i;
/** Teasing openers. */
const TEASING_OPENER = /^(?:h+m+|mm+|oh+|ah+|my my|well well)\b/i;
/** A line that already opens with a non-verbal in words ("Hmm, …", "Ha!", "Heh."): no snippet in front. */
const NON_VERBAL_OPENER = /^[\s"'“‘(]*(?:h+m+|mm+|ha(?:ha)*|heh|hah|hehe)\b/i;

/** Narration that is plainly tense (a few action words; deliberately short, the voice shouldn't overact). */
const TENSE_NARRATION =
  /\b(?:slammed|shattered|explod(?:ed|ing)|scream(?:ed|ing|s)?|shriek(?:ed|ing)?|crashed|lunged|froze|frozen|trembl(?:ed|ing)|terror|terrif(?:ied|ying)|panic(?:ked)?|blood|dread|doom|fear(?:ed|ful)?|afraid|horror|horrif(?:ied|ying)|shiver(?:ed|ing)?|chill(?:ed)?|uneasy|danger(?:ous)?|inescapable|menacing|desperate(?:ly)?|helpless(?:ly)?|struck|slash(?:ed|ing)?|stabb(?:ed|ing)|flames|ablaze|shaking|frighten(?:ed|ing)|dodg(?:e|ed|ing)|ducked|impal(?:ed|ing)|bleed(?:ing)?|too (?:fast|late|many)|hopeless(?:ly)?|struggl(?:ed|ing|es)|stopped breathing|held (?:his|her|their|my) breath|heart (?:pounded|pounding|raced|racing|hammered|hammering|thudded)|backed (?:away|down|off|up)|crept|creeping|footsteps|dragging|stand(?:ing)? on end|something (?:moved|pale|dark|shifted))\b/i;
/** Narration that settles even in a fight ("Luckily, …", "eerily beautiful", "grown somewhat confident"): calm. */
const CALM_NARRATION = /\b(?:luckily|fortunately|confident(?:ly)?|beautiful|steady|steadily|manageable|calm(?:ly)?|peace(?:ful)?|relie(?:f|ved)|comfort(?:ing|ed)?|good partner|safe(?:ly)?|smiled|going well|grew still|disappeared|empty|emptiness|silen(?:ce|t|tly))\b/i;
/** A thought or line that trails off is tense only when it says something alarming ("Curse it…", "not good…");
 * otherwise it is wistful ("I wonder how Dale is doing…"). */
const ALARM = /\b(?:curse|cursed|damn|damnation|hell|gods?|no+|not good|run|help|impossible|too (?:fast|many|late)|what)\b/i;
/** Sentences either side within which tense narration makes a hesitant line ("What… is… going on?") dread, not
 * a teasing drawl. */
const TENSE_REACH = 3;

/** Function words that are never the key word. */
const STOP_WORDS = new Set(
  'a an the to of and or but if in on at by for with from into onto about as is am are was were be been being it its me my mine you your yours him his her hers them their us our we they i he she this that these those so too very just then than there here do does did not no yes oh ah hmm mm can could will would shall should may might must have has had get got all any some what who whom how why when where which'.split(
    ' ',
  ),
);

/** All-caps words that are names of things, not shouting (kept as written). */
const ACRONYMS = new Set([
  'HP', 'MP', 'SP', 'XP', 'EXP', 'NPC', 'PVP', 'PVE', 'RPG', 'MMO', 'MMORPG', 'AI', 'OK', 'TV', 'CEO', 'FBI', 'CIA', 'USA', 'UK',
  'EU', 'UN', 'DNA', 'ID', 'IQ', 'GPS', 'CPU', 'GPU', 'STR', 'AGI', 'DEX', 'INT', 'WIS', 'VIT', 'END', 'LUK', 'CHA', 'DEF',
  'ATK', 'SSS', 'SS', 'RIP', 'LOL', 'DIY', 'ASAP', 'NASA', 'SWAT', 'POV', 'UFO', 'ATM', 'MVP', 'AOE', 'DPS', 'DOT', 'II',
  'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII',
]);
/** Common written sound effects (lower case; a few letters repeated count too: "Boooom"). */
const SFX_WORDS =
  /^(?:k?a?boo+m|bang|bam|blam|crack|crash|thud|thump|whoo+sh|swoo+sh|swish|pow|clang|clank|clink|snap|crunch|splash|splat|slam|ding|dong|click|clack|rumble|hiss|zap|wham|smash|pop|creak|drip|tick|tock|knock|thwack|whack|bzz+|vroo+m|screech|shatter|sizzle|tap|rattle|roar|growl|ugh|argh+|gah)$/i;

/** "Sunny's POV", "— Nephis —", "[POV: Cassie]", "Kai (POV)": a short line that switches the viewpoint. */
export const POV_HEADER = /^(?:\[?\s*POV\s*[:-]?\s*[\p{L} .'’-]{1,40}\]?|[\p{L} .'’-]{1,40}(?:'s|’s)?\s*\(?\s*POV\s*\)?|[-—–~*=•·]+\s*[\p{L} .'’-]{1,40}\s*[-—–~*=•·]+)$/iu;

/** Narration takes the scene's mood, toned down (narration describes, the characters act). */
const NARRATION_SCENE: Readonly<Record<Mood, Mood>> = {
  calm: 'calm', soft: 'soft', sad: 'sad', tense: 'tense', playful: 'calm', intense: 'tense', whisper: 'soft', system: 'calm',
};

// ================================================================ parameters

export interface DeliveryJson {
  /** Temperature. */
  t: number;
  /** Gain dB. */
  g: number;
  /** Tempo (NATURAL_TEMPO included). */
  s: number;
  /** Pitch offset, cents. */
  c?: number;
  /** Silence before the line, ms at 1.0×. */
  pre?: number;
  /** A non-verbal from the voice's pack in front of the line (none without a pack). */
  nv?: NonVerbal;
  /** The text for Nano when it differs from the item's text (reshaped emphasis, a falling ending, a key-word pause). */
  say?: string;
  /** Syllables Nano will say (native levels the speaking rate: syllables per second of voiced audio). */
  syl?: number;
  /** Where a dramatic "…" sits inside the sentence (share of its letters before it): native stretches the model's
   * own pause nearest to it. */
  ell?: number[];
  /** Where punctuation sits inside the sentence (share of letters): a short gap there is a real pause, kept. */
  pun?: number[];
}

const clamp = (x: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, x));
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Syllables of one word (vowel groups, a silent final "e", at least one). */
function wordSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (trimmed.match(/[aeiouy]{1,2}/g) ?? []).length);
}

/** Syllables of a line (sound tags and punctuation don't count). */
export function syllables(text: string): number {
  return (text.replace(/\[[a-z ]+\]/gi, ' ').match(/[\p{L}'’]+/gu) ?? []).reduce((n, w) => n + wordSyllables(w), 0);
}

/**
 * What native needs to shape the rendered sentence (the text Nano reads): its syllables (rate leveling), where a
 * dramatic "…" sits (a "…" with more words after it) and where punctuation sits, as shares of the letters.
 */
export function speechShape(text: string): Pick<DeliveryJson, 'syl' | 'ell' | 'pun'> {
  const plain = text.replace(/\[[a-z ]+\]/gi, ' ');
  const total = letterCount(plain);
  const out: Pick<DeliveryJson, 'syl' | 'ell' | 'pun'> = { syl: syllables(plain) };
  if (total === 0) return out;
  const ell: number[] = [];
  const pun: number[] = [];
  for (const m of plain.matchAll(/…|\.\.\.|[,;:—–]/g)) {
    const before = letterCount(plain.slice(0, m.index));
    if (before === 0 || before >= total) continue; // only inside the sentence
    const share = Math.round((before / total) * 1000) / 1000;
    pun.push(share);
    if (m[0] === '…' || m[0] === '...') ell.push(share);
  }
  if (ell.length > 0) out.ell = ell;
  if (pun.length > 0) out.pun = pun;
  return out;
}

/** The line class of a cue (narration / plain dialogue when the director didn't name one). */
export function lineClass(cue: Pick<Cue, 'line' | 'dialogue'>): LineClass {
  return cue.line ?? (cue.dialogue ? 'dialogue' : 'narration');
}

/** The synthesis parameters of one sentence. */
export function deliveryParams(cue: Cue): Omit<DeliveryJson, 'say'> {
  const m = MOOD_TABLE[cue.mood];
  const k = CLASS_TABLE[cue.mood === 'system' ? 'narration' : lineClass(cue)];
  let t = cue.dialogue && cue.mood !== 'system' ? Math.min(m.t + DIALOGUE_LIFT_T, Math.max(m.t, DIALOGUE_LIFT_CAP)) : m.t;
  let g = m.g + k.g;
  let s = clamp(m.s, cue.mood === 'system' ? [1, m.s] : TEMPO_RANGE) * k.tempo * (cue.ellipsis && cue.mood !== 'system' ? ELLIPSIS_TEMPO : 1);
  if (cue.stress) {
    const lift = STRESS_LIFT[cue.stress];
    t += lift.t;
    g += lift.g;
    s *= lift.s;
  }
  const out: Omit<DeliveryJson, 'say'> = {
    t: r3(clamp(t, TEMPERATURE_RANGE)),
    g: r3(clamp(g, GAIN_RANGE_DB)),
    s: r3(clamp(NATURAL_TEMPO * s, TEMPO_LIMITS)),
  };
  const cents = PER_LINE_PITCH ? Math.round(clamp(k.cents, CENTS_RANGE)) : 0;
  if (cents !== 0) out.c = cents;
  if (cue.nv) out.nv = cue.nv;
  if (cue.stress === 'sfx') out.pre = SFX_PRE_PAUSE_MS;
  return out;
}

/** Extra silence after a line (a command's room to land), ms at 1.0×. */
export function pauseAfter(cue: Cue): number {
  return cue.mood === 'system' ? 0 : (CLASS_TABLE[lineClass(cue)].pauseAfterMs ?? 0);
}

// ================================================================ emphasis

const capsWords = (display: string): string[] =>
  (display.match(/\b[A-Z][A-Z'’]{2,}\b/g) ?? []).filter((w) => !ACRONYMS.has(w.replace(/['’].*$/, '')));

/** ALL CAPS words or a sound effect in the sentence as shown. */
function textStress(display: string): Stress | undefined {
  const words = display.match(/[\p{L}'’]+/gu) ?? [];
  const caps = capsWords(display);
  const end = display.trim().replace(/["'”’»)\]*_]+$/u, '');
  if (words.length > 0 && words.length <= 3) {
    const sfx = words.some((w) => SFX_WORDS.test(w.replace(/(\p{L})\1{2,}/gu, '$1$1')));
    if ((sfx || caps.length > 0) && /[!—–…-]$|\.$/.test(end) && (sfx || caps.length === words.length)) return 'sfx';
  }
  return caps.length > 0 ? 'word' : undefined;
}

/** Lower case, straight quotes, single spaces, no punctuation at the ends. */
export function normalizeFragment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.,!?;:…—–-]+|[\s"'.,!?;:…—–-]+$/gu, '');
}

const letterCount = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
const isWordChar = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);

/** Index of `needle` in `hay` on word boundaries, from `from`; -1 when absent. */
function wordIndex(hay: string, needle: string, from = 0): number {
  for (let at = hay.indexOf(needle, from); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at > 0 ? hay.charAt(at - 1) : ' ';
    const after = hay.charAt(at + needle.length);
    if (!isWordChar(before) && (!after || !isWordChar(after))) return at;
  }
  return -1;
}

/** A whole sentence (this share of its letters, or more) in italics is a thought. */
export const THOUGHT_SHARE = 0.75;
/** Bold longer than this is styling (a system box, a heading), not stress. */
export const BOLD_MAX_LETTERS = 120;
/** How far ahead (in sentences) an emphasized fragment is looked for. */
const EMPHASIS_LOOKAHEAD = 40;

/** The text of one <em>/<i> (italic) or <strong>/<b> (bold) element. */
export interface Emphasis {
  text: string;
  bold?: boolean;
}

export interface Marked {
  stress: Stress;
  /** The italic word or short phrase of a stressed word (absent for a thought). */
  word?: string;
}

/**
 * Emphasized fragments (in document order) → stress per sentence. Fragments are matched in order, each at or
 * after the sentence the previous one matched, so a short word ("was") lands where it was written, not wherever
 * it occurs first. An italic fragment spanning sentences is matched sentence by sentence; a whole italic
 * sentence is a thought, bold is only ever a stressed word.
 */
export function alignEmphasis(displays: readonly string[], fragments: readonly Emphasis[]): (Marked | undefined)[] {
  const out: (Marked | undefined)[] = displays.map(() => undefined);
  const norm = displays.map(normalizeFragment);
  const letters = displays.map(letterCount);
  let cursor = 0;
  const place = (fragment: string, bold: boolean): boolean => {
    const f = normalizeFragment(fragment);
    const n = letterCount(f);
    if (n < 2 || (bold && n > BOLD_MAX_LETTERS)) return false;
    for (let k = cursor; k < Math.min(displays.length, cursor + EMPHASIS_LOOKAHEAD); k++) {
      if (wordIndex(norm[k] ?? '', f) < 0) continue;
      const share = n / Math.max(1, letters[k] ?? 1);
      const prev = out[k];
      if (prev?.stress === 'thought' || (!bold && share >= THOUGHT_SHARE)) out[k] = { stress: 'thought' };
      else out[k] = { stress: 'word', word: prev?.word ?? f };
      cursor = k;
      return true;
    }
    return false;
  };
  for (const e of fragments) {
    const bold = e.bold === true;
    if (place(e.text, bold) || bold) continue;
    for (const piece of e.text.split(/(?<=[.!?…])\s+/)) place(piece, false);
  }
  return out;
}

/** The last word that carries meaning ("…when you're flustered" → "flustered"). */
export function lastContentWord(text: string): string | undefined {
  const words = text.match(/[\p{L}][\p{L}'’]*/gu) ?? [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] ?? '';
    if (!STOP_WORDS.has(w.toLowerCase().replace(/['’]/g, "'")) && w.length > 1) return w;
  }
  return undefined;
}

/**
 * The text Nano reads (the display text is never touched): what's left of ALL CAPS in lower case (Nano spells
 * or shouts capitals); a sound effect ending in a dash stops instead of trailing off; a command's "!" falls to
 * "."; a pause ("…" or ",") before the key word. Non-verbals are never written in (Nano's tags sounded robotic and
 * roughened the speech after them): native splices a recorded one in front (DeliveryJson.nv).
 */
export function nanoText(text: string, cue: Pick<Cue, 'stress' | 'line' | 'dialogue' | 'keyWord'>): string {
  let out = text.replace(/\b[A-Z][A-Z'’]{2,}\b/g, (w, at: number) => {
    if (ACRONYMS.has(w.replace(/['’].*$/, ''))) return w;
    const lower = w.toLowerCase();
    const sentenceStart = at === 0 || /[.!?…"“]\s*$/.test(text.slice(0, at));
    return sentenceStart ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  if (cue.stress === 'sfx') out = out.replace(/\s*[—–-]+(["'”’]*)\s*$/u, '!$1');
  const k = CLASS_TABLE[lineClass(cue)];
  if (k.fallingEnd) out = out.replace(/\?!+/g, '?').replace(/!+/g, '.').replace(/\.{2,}/g, '.');
  if (cue.keyWord) {
    const mark = k.keyWordPause ?? STRESS_KEY_WORD_PAUSE;
    const lower = out.toLowerCase();
    const word = cue.keyWord.toLowerCase().replace(/[‘’]/g, "'");
    // The italic word: its first place in the line; the last content word: its last place.
    let at = -1;
    for (let i = wordIndex(lower, word); i >= 0; i = wordIndex(lower, word, i + 1)) {
      at = i;
      if (cue.stress === 'word') break;
    }
    let before = out.slice(0, Math.max(0, at)).trimEnd();
    let rest = at >= 0 ? out.slice(at) : '';
    // A conjunction goes with the key word ("…here, and look at me", not "and, look").
    const conj = /\s(and|or|but|so|nor|yet|then)$/i.exec(before);
    if (conj) {
      rest = `${before.slice(conj.index + 1)} ${rest}`;
      before = before.slice(0, conj.index).trimEnd();
    }
    // Two words or more before it (not "I, told you"), and no punctuation already pausing there.
    const wordsBefore = (before.match(/\p{L}[\p{L}'’]*/gu) ?? []).length;
    if (at > 0 && wordsBefore >= 2 && /[\p{L}\p{N}'’]$/u.test(before)) out = `${before}${mark} ${rest}`;
  }
  return out;
}

// ================================================================ the director

interface Match {
  mood: Mood;
  nv?: NonVerbal;
}

function matchMood(text: string): Match | null {
  if (!text) return null;
  for (const [mood, nv, re] of MOOD_RULES) if (re.test(text)) return nv ? { mood, nv } : { mood };
  return null;
}

function matchClass(text: string): LineClass | null {
  if (!text) return null;
  for (const [cls, re] of CLASS_TAG_RULES) if (re.test(text)) return cls;
  return null;
}

const trimEnd = (s: string): string => s.trim().replace(/["'”’»)\]*_]+$/u, '');

/** The dialogue's own punctuation, when no tag says how it's spoken. */
function punctuationMood(display: string): Mood {
  const t = trimEnd(display);
  if (/!\??$|\?!$/.test(t)) return 'intense';
  if (/(?:…|\.\.\.|—|–)$/.test(t)) return 'soft';
  return 'calm';
}

/** The class the spoken words suggest (an order, an endearment, a teasing opener or drawl), or null. `dread`: in a
 * tense stretch (or a thought) a drawl, an "Ah…"/"Hmm" opener or a question is hesitation, never teasing. */
function speechClass(speech: string, mood: Mood, dread = false): LineClass | null {
  const words = speech.replace(/^[\s"'“”‘’(]+/u, '');
  const question = /\?/.test(words);
  if (!question && IMPERATIVE.test(words)) return 'commanding';
  if (TENDER_SPEECH.test(words)) return 'tender';
  if (dread) return null;
  const relaxed = mood === 'calm' || mood === 'playful' || mood === 'soft';
  if (relaxed && TEASING_OPENER.test(words)) return 'teasing';
  // A drawl in the middle of a line ("cute when you're… flustered"); a trailing "…" is just trailing off.
  if (relaxed && /(?:…|\.\.\.)\s*\p{L}/u.test(words)) return 'teasing';
  if (mood === 'playful' && question) return 'teasing';
  return null;
}

/** "Damna… tion" → "Damnation" (a word broken by a trailing-off ellipsis), for word tests. */
const joinBroken = (t: string): string => t.replace(/(\p{L})(?:…|\.\.\.)\s*(\p{Ll})/gu, '$1$2');

/** The narration just before a dialogue paragraph that introduces it ("…the Sin of Solace sighed.", "…gloating:"),
 * or -1: the previous sentence, in the previous block, narration, ending its paragraph with a colon or a speech verb. */
function leadIn(list: readonly DirectorSentence[], i: number): number {
  const s = list[i];
  const p = list[i - 1];
  const next = list[i + 1];
  if (!s || !p || p.kind !== 'text' || p.block === s.block || p.dialogueShare > 0) return -1;
  if (next && next.block === s.block && next.dialogueShare === 0) return -1; // the paragraph has its own narration
  return /:$|\b(?:said|says|sighed|whispered|muttered|murmured|sneered|gloated|gloating|mocked|asked|replied|shouted|yelled|growled|hissed|snapped|laughed|chuckled|purred|ordered)\.?$/i.test(trimEnd(p.display)) ? i - 1 : -1;
}

/** The nearest index in the same paragraph (the following one first) for which `has` is true, or -1. */
function nearestInParagraph(list: readonly DirectorSentence[], i: number, has: (j: number) => boolean): number {
  if (has(i)) return i;
  const block = list[i]?.block;
  for (let d = 1; d < list.length; d++) {
    const after = i + d;
    const before = i - d;
    const inAfter = after < list.length && list[after]?.block === block;
    const inBefore = before >= 0 && list[before]?.block === block;
    if (!inAfter && !inBefore) return -1;
    if (inAfter && has(after)) return after;
    if (inBefore && has(before)) return before;
  }
  return -1;
}

/**
 * One cue per sentence. Dialogue takes its mood (and class) from its own dialogue tag ("…,” she whispered),
 * else from the nearest tag or beat in the same paragraph (the following one first: attribution usually comes
 * after the words), else from its punctuation and words. Narration is calm unless it ends with "!" or has a
 * tense action word. Then the scene pass (smoothScenes). A non-verbal goes on the first dialogue sentence a
 * laugh/chuckle applies to, on a teasing line once every TEASING_CHUCKLE_EVERY teasing lines (chuckle and "hm" in
 * turn) or rarely on a tender one ("mm"), at most once every MIN_TAG_GAP sentences. Teasing and commanding lines
 * and stressed italic words get a pause before the key word, at most once every KEY_WORD_GAP sentences.
 */
export function direct(list: readonly DirectorSentence[], opts: { emphasis?: readonly Emphasis[] } = {}): Cue[] {
  const moodTag = list.map((s) => (s.kind === 'text' ? matchMood(s.narration) : null));
  const tenseAt = list.map((s) => s.kind === 'text' && s.dialogueShare === 0 && TENSE_NARRATION.test(s.display));
  const tenseNear = (i: number): boolean => tenseAt.some((t, j) => t && Math.abs(j - i) <= TENSE_REACH);
  const classTag = list.map((s) => (s.kind === 'text' ? matchClass(s.narration) : null));
  const marked = opts.emphasis?.length ? alignEmphasis(list.map((s) => s.display), opts.emphasis) : [];
  const usedNv = new Set<number>(); // sentences whose attribution spent its non-verbal
  let lastNv = -Infinity;
  let previousNv: NonVerbal | undefined;
  let teasingSince = Infinity;
  const cues = list.map((s, i): Cue => {
    const dialogue = s.kind === 'text' && s.dialogueShare >= DIALOGUE_SHARE;
    let fromText = s.kind === 'text' ? textStress(s.display) : undefined;
    // Sound effects are narration; a shouted one-word line in quotes ("STOP!") is a stressed word.
    if (fromText === 'sfx' && s.dialogueShare > 0) fromText = 'word';
    const mark = marked[i];
    // A sound effect beats a thought beats a stressed word.
    const stress: Stress | undefined = fromText === 'sfx' ? 'sfx' : (mark?.stress ?? fromText);
    const withStress = (c: Cue): Cue => (stress ? { ...c, stress } : c);
    if (s.kind === 'system') return { mood: 'system', dialogue: false };
    if (s.kind === 'title') return { mood: 'calm', dialogue: false };
    if (s.dialogueShare === 0) {
      // A whole italic sentence is a thought: softer, and kept as written (markup is as clear as a tag).
      if (stress === 'thought') return { mood: 'soft', dialogue, explicit: true, stress };
      const t = trimEnd(s.display);
      const mood: Mood =
        /!$/.test(t) && stress !== 'sfx' ? 'intense' : TENSE_NARRATION.test(s.display) && !CALM_NARRATION.test(s.display) ? 'tense' : 'calm';
      return withStress({ mood, dialogue, ...(CALM_NARRATION.test(s.display) ? { settled: true } : {}) });
    }
    // Speech: its own tags, else the nearest ones in the paragraph.
    const lead = leadIn(list, i);
    let mFrom = nearestInParagraph(list, i, (j) => !!moodTag[j]);
    let cFrom = nearestInParagraph(list, i, (j) => !!classTag[j]);
    if (mFrom < 0 && lead >= 0 && moodTag[lead]) mFrom = lead;
    if (cFrom < 0 && lead >= 0 && classTag[lead]) cFrom = lead;
    const m = mFrom >= 0 ? moodTag[mFrom] : null;
    const tense = tenseNear(i);
    let mood: Mood = m?.mood ?? punctuationMood(s.display);
    // Trailing off in a tense stretch is dread when it says something alarming ("'Ah… not good…'"), else wistful.
    let settledMood = false;
    if (!m && tense && mood === 'soft' && ALARM.test(joinBroken(s.speech || s.display))) {
      mood = 'tense';
      settledMood = true;
    }
    // A plain thought surrounded by tense narration ("'Someone's up there.'") carries the tension.
    if (!m && s.thought && mood === 'calm' && tenseAt.filter((t, j) => t && Math.abs(j - i) <= TENSE_REACH).length >= 2) {
      mood = 'tense';
      settledMood = true;
    }
    // A thought shouted inside a tense stretch is tense, not intense (it isn't excitement).
    if (!m && tense && mood === 'intense' && s.thought) {
      mood = 'tense';
      settledMood = true;
    }
    // Any spoken words can carry a class ("“Kneel!” she ordered." is mostly attribution but still an order).
    const line: LineClass | null = (cFrom >= 0 ? classTag[cFrom] : null) ?? speechClass(s.speech ?? s.display, mood, tense || !!s.thought);
    // A class sets the mood it reads in, unless a tag said how the line is spoken.
    const classMood = line ? CLASS_TABLE[line].mood : undefined;
    if (classMood && !m) mood = classMood;
    // Quiet authority, never shouting; but an order in a fight ("Get inside! Now!") is urgent.
    if (line === 'commanding' && (mood === 'intense' || mood === 'tense')) mood = tense ? 'tense' : 'calm';
    else if (line === 'commanding' && tense && !m) mood = 'tense';
    const cue: Cue = { mood, dialogue, ...(m || line || settledMood ? { explicit: true } : {}), ...(line ? { line } : {}) };
    // A non-verbal: the one the attribution names (laughed, chuckled), else a teasing line's chuckle or "hm" every
    // TEASING_CHUCKLE_EVERY teasing lines, a tender line's "mm"; sparingly, never twice the same in a row, never
    // where the line already says it ("Hmm, …", "Ha!").
    const free = i - lastNv >= MIN_TAG_GAP && !NON_VERBAL_OPENER.test(s.speech || s.display);
    if (line === 'teasing') teasingSince++;
    let nv: NonVerbal | undefined;
    if (m?.nv && !usedNv.has(mFrom)) nv = m.nv;
    else if (line === 'teasing' && teasingSince >= TEASING_CHUCKLE_EVERY) nv = previousNv === 'chuckle' ? 'hm' : 'chuckle';
    else if (line === 'tender' && i - lastNv >= 2 * MIN_TAG_GAP) nv = 'mm';
    if (nv && nv === previousNv) nv = nv === 'chuckle' ? 'hm' : nv === 'hm' ? 'mm' : nv === 'mm' ? 'hm' : 'chuckle';
    if (nv && free) {
      cue.nv = nv;
      if (m?.nv) usedNv.add(mFrom);
      lastNv = i;
      previousNv = nv;
      if (line === 'teasing') teasingSince = 0;
    }
    return withStress(cue);
  });
  cues.forEach((c, i) => {
    if (list[i]?.kind === 'text' && /…|\.\.\./.test(list[i]?.display ?? '')) c.ellipsis = true;
  });
  // Key-word pauses: a gesture, not a tic.
  let lastKey = -Infinity;
  cues.forEach((c, i) => {
    const s = list[i];
    if (!s || s.kind !== 'text' || i - lastKey < KEY_WORD_GAP) return;
    const k = CLASS_TABLE[lineClass(c)];
    const italic = c.stress === 'word' ? marked[i]?.word : undefined;
    if (!k.keyWordPause && !italic) return;
    const words = (s.speech || s.display).match(/[\p{L}][\p{L}'’]*/gu) ?? [];
    if (words.length < 3) return;
    const key = italic ?? lastContentWord(s.speech || s.display);
    if (!key) return;
    c.keyWord = key;
    lastKey = i;
  });
  return smoothScenes(cues, list);
}

/** The scene pass of `direct` (exported for tests): inside a scene, a sentence whose mood doesn't come from a tag
 * or markup takes the majority of its window (narration in a toned-down form), so the tone carries. */
export function smoothScenes(cues: readonly Cue[], list: readonly Pick<DirectorSentence, 'kind' | 'sceneStart'>[]): Cue[] {
  const scene: number[] = [];
  let n = 0;
  list.forEach((s, i) => {
    if (i > 0 && (s.sceneStart || s.kind === 'title')) n++;
    scene.push(n);
  });
  return cues.map((c, i) => {
    if (c.explicit || c.mood === 'system' || list[i]?.kind !== 'text') return c;
    const votes = new Map<Mood, number>();
    for (let j = Math.max(0, i - SCENE_WINDOW); j <= Math.min(cues.length - 1, i + SCENE_WINDOW); j++) {
      const v = cues[j];
      if (!v || scene[j] !== scene[i] || list[j]?.kind !== 'text') continue;
      votes.set(v.mood, (votes.get(v.mood) ?? 0) + (j === i ? OWN_VOTE[c.dialogue ? 'dialogue' : 'narration'] : 1));
    }
    let best: Mood = c.mood;
    let top = votes.get(c.mood) ?? 0;
    for (const [mood, w] of votes) {
      if (w > top) {
        best = mood;
        top = w;
      }
    }
    let mood = c.dialogue ? (best === 'whisper' ? 'soft' : best) : NARRATION_SCENE[best];
    // Tension carries through narration: two tense or intense sentences within TENSE_REACH make it tense, however
    // many calm ones are around (a fight is mostly description; it shouldn't be voted calm).
    if (!c.dialogue && !c.settled && (mood === 'calm' || mood === c.mood)) {
      let near = 0;
      for (let j = Math.max(0, i - TENSE_REACH); j <= Math.min(cues.length - 1, i + TENSE_REACH); j++) {
        const v = cues[j];
        if (v && scene[j] === scene[i] && (v.mood === 'tense' || v.mood === 'intense')) near++;
      }
      if (near >= 2 && (mood === 'calm' || mood === 'tense')) mood = 'tense';
    }
    return mood === c.mood ? c : { ...c, mood };
  });
}

// ================================================================ natural pauses

/**
 * The context pause model (Kasta's pacing findings, round 8; round8.json carries the final numbers): the pause
 * after a sentence depends on what it hands over to. Each range is the base ± the jitter.
 */
export const PAUSE_MODEL = {
  /** The same speaker goes on (the same quotation, or a quote paragraph that continues without a closing quote). */
  sameSpeaker: [380, 480],
  /** Narration sentence → narration sentence in a paragraph. */
  narration: [450, 600],
  /** Narration ↔ dialogue. */
  switch: [550, 750],
  /** A new paragraph or scene in narration. */
  paragraph: [850, 1000],
  /** After a one-word command ("Kneel."). */
  command: [450, 550],
  /** One speaker hands over to another (not in the findings: between sameSpeaker and switch). */
  exchange: [500, 650],
} as const satisfies Record<string, readonly [number, number]>;
export type PauseContext = keyof typeof PAUSE_MODEL;
/** Variation around each context's middle, uniform in ±PAUSE_JITTER (the findings: ±10 %; approved test B ±15 %). */
export const PAUSE_JITTER = 0.1;
/** After a sentence ending in "…" inside a paragraph, and after an intense line (approved test B). */
export const ELLIPSIS_PAUSE = 1.2;
export const INTENSE_PAUSE = 0.85;
/** Scene breaks, titles and system messages keep the front-end's pause unless a context applies. */
const STRUCTURAL_MS = 900;
/** The front-end's pause between the halves of an over-long sentence: kept short and steady. */
const CLAUSE_MS = 160;

/** mulberry32: a small seeded PRNG (uniform in [0, 1)). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A factor in [1 − amount, 1 + amount] (at most ±30 %), the same for the same seed. */
export function pauseJitter(seed: number, amount = PAUSE_JITTER): number {
  const next = rng(Number.isFinite(seed) ? seed : 0);
  const a = Math.min(0.3, Math.max(0, amount));
  return 1 + (next() * 2 - 1) * a;
}

/** The seed of a sentence: its text hash and its place in the chapter. */
export function pauseSeed(hash: number, id: number): number {
  return (hash ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0;
}

/** One side of a sentence boundary. */
export interface PauseSide {
  block: number;
  kind: 'title' | 'text' | 'system';
  /** The sentence ends inside quotation marks (its last words are spoken). */
  endsSpoken: boolean;
  /** The sentence starts inside quotation marks. */
  startsSpoken: boolean;
  /** A quotation is still open at the end (the speaker goes on in the next paragraph). */
  quoteOpen: boolean;
  /** A one-word command ("Kneel.", "Now."). */
  command?: boolean;
}

/** What the boundary after `cur` hands over to, or undefined (the end, titles, system messages). */
export function pauseContext(cur: PauseSide, next: PauseSide | undefined, scene = false): PauseContext | undefined {
  if (!next || cur.kind !== 'text' || next.kind !== 'text') return undefined;
  if (cur.command) return 'command';
  if (scene) return 'paragraph';
  const sameParagraph = next.block === cur.block;
  if (cur.endsSpoken && next.startsSpoken) return sameParagraph || cur.quoteOpen ? 'sameSpeaker' : 'exchange';
  if (!cur.endsSpoken && !next.startsSpoken) return sameParagraph ? 'narration' : 'paragraph';
  return 'switch';
}

export interface PauseInput {
  kind: 'title' | 'text' | 'system';
  display: string;
  /** The front-end's pause (classic pacing). */
  pauseMs: number;
  /** The relaxed pacing pause (narrator.ts pacedPause, 'relaxed'): used without a context. */
  relaxedMs: number;
  /** The next sentence is in the same paragraph. */
  sameParagraphNext: boolean;
  /** The boundary's context (pauseContext). */
  context?: PauseContext;
  /** The sentence was read intense (a shorter pause keeps the energy). */
  intense?: boolean;
  seed: number;
}

/** The natural-delivery pause after a sentence (ms at 1.0×). Titles, system messages and structure keep theirs. */
export function naturalPause(s: PauseInput): number {
  if (s.kind !== 'text' || s.pauseMs === CLAUSE_MS) return s.relaxedMs;
  if (!s.context) return s.pauseMs >= STRUCTURAL_MS ? s.relaxedMs : Math.round(s.relaxedMs * pauseJitter(s.seed));
  const [lo, hi] = PAUSE_MODEL[s.context];
  let base = (lo + hi) / 2;
  if (s.sameParagraphNext && /…|\.\.\./.test(s.display)) base *= ELLIPSIS_PAUSE;
  if (s.intense) base *= INTENSE_PAUSE;
  return Math.round(base * pauseJitter(s.seed));
}

// ================================================================ breaths

/** Where a breath may go: in the pause after a sentence, before a new paragraph or after a sentence-final pause. */
export type BreathPoint = 'paragraph' | 'sentence';

export interface BreathInput {
  block: number;
  kind: 'title' | 'text' | 'system';
  /** Has spoken words (any share inside quotation marks). */
  speaks: boolean;
}

/**
 * A breath candidate after sentence `cur` (native decides with its lung budget and fits it in the pause, or
 * skips it; it never adds time): before a new paragraph, or after a sentence-final pause of BREATH_MIN_PAUSE_MS
 * or more. Never inside a quotation that goes on into the next sentence, never in a back-and-forth of dialogue.
 */
export function breathPoint(cur: BreathInput, next: (BreathInput & { continuesQuote: boolean }) | undefined, pauseMs: number): BreathPoint | undefined {
  if (!next) return undefined;
  if (next.continuesQuote) return undefined;
  if (cur.speaks && next.speaks && cur.kind === 'text' && next.kind === 'text') return undefined; // an exchange
  if (next.block !== cur.block) return 'paragraph';
  return pauseMs >= DELIVERY_AUDIO.breathMinPauseMs ? 'sentence' : undefined;
}

// ================================================================ the audio side's tunables

/**
 * Numbers the native audio side uses for natural delivery, sent with every script so a web update can retune
 * them (native keeps the same values as defaults and clamps what it gets).
 */
export const DELIVERY_AUDIO = {
  /** Breath level relative to the speech RMS, dB (approved: −22 everywhere). */
  breathDb: -22,
  /** Lung budget: seconds of speech since the last breath before the next one (a random point in the range),
   * and the shorter budget at a paragraph start. */
  breathEverySec: [6, 8] as const,
  breathParagraphSec: 4,
  /** Only pauses this long (ms at 1.0×) can hold a breath inside a paragraph. */
  breathMinPauseMs: 400,
  /** The inhale starts this long after the previous sentence ends and ends this long before the next starts
   * (random per breath within the ranges); it is shortened to fit, and skipped below breathShortestMs. */
  breathStartMs: [120, 200] as const,
  breathEndMs: [80, 150] as const,
  breathShortestMs: 140,
  /** "procedural" (shaped noise, the default), "snippets" (cut from the voice, cached) or "pack" (recorded). */
  breathSource: 'procedural' as 'procedural' | 'snippets' | 'pack',
  /** Edge fades of every sentence (equal power), ms. */
  fadeMs: 8,
  /** Fades at the joins of one text's several model calls, ms. */
  crossfadeMs: 10,
  /** Per-chunk loudness matching target (speech RMS), dBFS. */
  speechRmsDb: -20,
  /** Rate leveling: each chunk's speaking rate (syllables per voiced second) is stretched toward the median of the
   * last rateWindow chunks when it is more than rateBand off, never by more than rateCap. */
  rateWindow: 9,
  rateBand: 0.04,
  rateCap: 0.1,
  /** Inside the speech: close gaps shorter than this that aren't at punctuation, drop isolated blips shorter than
   * this, and stretch the model's own pause at a dramatic "…" to this long (ms). */
  microGapMs: 110,
  blipMs: 70,
  ellipsisPauseMs: [350, 450] as const,
  /** Roughness guard: a chunk whose voiced periodicity drops this far below the voice's running median for this
   * long is rendered once more with another seed (only with enough audio queued) and the better one kept. */
  roughnessDrop: 0.12,
  roughnessMs: 250,
  /** Non-verbals: the gap between the snippet and the line (random in the range), the snippet's fades, and its level
   * against the line's speech. */
  nonVerbalGapMs: [80, 200] as const,
  nonVerbalFadeMs: 10,
  nonVerbalDb: -3,
};

/** Breath-group synthesis: the narrator voice reads a paragraph (or a same-speaker run of quote paragraphs) per call,
 * split at sentence ends under this many characters: the longest call of any Listen engine (Pocket TTS, 400).
 * Native splits a chunk further at the engine's own limit (ExpressiveEngineID.maxCharactersPerCall; Nano 120). */
export const CHUNK_MAX_CHARS = 400;
/** Lines whose temperatures differ by more than this don't share a call (one temperature per call: the chunk's
 * letter-weighted mean). */
export const CHUNK_MAX_T_STEP = 0.1;

export interface ChunkInput {
  block: number;
  kind: 'title' | 'text' | 'system';
  /** Characters Nano reads for the sentence. */
  chars: number;
  startsSpoken: boolean;
  /** A quotation is still open at the end of the sentence (the speaker goes on in the next paragraph). */
  quoteOpen: boolean;
  /** Nano's temperature for the sentence: a call has one, so very different lines don't share one. */
  t?: number;
  /** Which read of the narrator voice (narrator, performed, a mood): one call reads in one voice. */
  voice?: string;
}

/**
 * Chunk ids for breath-group synthesis (one Nano call per chunk): a paragraph is a chunk; a quote paragraph that
 * continues the same speaker (the quotation was left open, no narration between) joins the one before; titles
 * and system messages stand alone; a chunk ends at a sentence end before it would pass maxChars, or where the
 * temperature differs by more than CHUNK_MAX_T_STEP, or where narration turns into performed speech or back. Native starts every Listen/seek with the first sentence alone (fast
 * start), then follows these.
 */
export function planChunks(list: readonly ChunkInput[], maxChars = CHUNK_MAX_CHARS): number[] {
  const ids: number[] = [];
  let id = -1;
  let chars = 0;
  list.forEach((s, i) => {
    const prev = list[i - 1];
    const continues = !!prev && (prev.block === s.block || (prev.quoteOpen && s.startsSpoken));
    const fresh =
      !prev ||
      s.kind !== 'text' ||
      prev.kind !== 'text' ||
      !continues ||
      (prev.voice ?? 'narrator') !== (s.voice ?? 'narrator') ||
      Math.abs((prev.t ?? 0.7) - (s.t ?? 0.7)) > CHUNK_MAX_T_STEP ||
      (chars > 0 && chars + 1 + s.chars > maxChars);
    if (fresh) {
      id++;
      chars = s.chars;
    } else chars += 1 + s.chars;
    ids.push(id);
  });
  return ids;
}

/** Shipped once per script: what native needs to follow refined moods and the audio tunables. */
export interface DeliveryHeader {
  version: 1;
  moods: Readonly<Record<Mood, MoodParams>>;
  tempo: number;
  audio: typeof DELIVERY_AUDIO;
}

export const DELIVERY_HEADER: DeliveryHeader = { version: 1, moods: MOOD_TABLE, tempo: NATURAL_TEMPO, audio: DELIVERY_AUDIO };

// ================================================================ Voice Lab lines

/** A line of a Voice Lab sample (or pasted text): hand-annotated emotion/style when it has one. */
export interface LineIn {
  text: string;
  emotion?: string;
  style?: string;
}

export interface LineDelivery {
  mood: Mood;
  line: LineClass;
  dialogue: boolean;
  delivery: DeliveryJson;
  /** Natural pause after the line, ms at 1.0×. */
  pauseMs: number;
  /** A breath may go in the pause after the line. */
  breath?: BreathPoint;
}

/** 24-bit FNV-1a of a line (the pause seed). */
function fnv24(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xffffff;
}

/**
 * The relaxed pause after a one-sentence paragraph (narrator.ts pacedPause with the 'relaxed' preset gives the
 * same: a quick exchange of short lines 650 ms, a long paragraph 1200 ms, otherwise 1000 ms).
 */
function relaxedParagraphPause(text: string, share: number, nextShare: number, last: boolean): number {
  if (last) return 700;
  if (share > 0 && nextShare > 0 && text.length < 140) return 650;
  return text.length > 450 ? 1200 : 1000;
}

/** The Voice Lab's hand annotations, as moods (they win over the rules, like a dialogue tag). */
const EMOTION_MOOD: Readonly<Record<string, Mood>> = { angry: 'intense', sad: 'sad', fearful: 'tense', happy: 'playful', surprised: 'intense', disgusted: 'tense' };
const STYLE_MOOD: Readonly<Record<string, Mood>> = { whisper: 'whisper', dramatic: 'tense', sarcastic: 'playful', narration: 'calm' };

/** The words outside and inside quotation marks, and the share of letters inside them. */
export function quoteSplit(text: string): { narration: string; speech: string; dialogueShare: number } {
  let inQuote = false;
  let inside = 0;
  let total = 0;
  let narration = '';
  let speech = '';
  for (const ch of text) {
    if (ch === '“' || (ch === '"' && !inQuote)) inQuote = true;
    else if (ch === '”' || ch === '"') {
      inQuote = false;
      speech += ' ';
    } else {
      if (/[\p{L}\p{N}]/u.test(ch)) {
        total++;
        if (inQuote) inside++;
      }
      if (inQuote) speech += ch;
      else narration += ch;
    }
  }
  const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return { narration: tidy(narration), speech: tidy(speech), dialogueShare: total > 0 ? inside / total : 0 };
}

/**
 * Natural delivery for Voice Lab lines (each line is its own paragraph): the director over the lines, the
 * hand annotations on top, relaxed pauses with the same variation as chapters.
 */
export function deliverLines(lines: readonly LineIn[]): LineDelivery[] {
  const split = lines.map((l) => quoteSplit(l.text));
  const list: DirectorSentence[] = lines.map((l, i) => ({
    block: i,
    kind: 'text',
    display: l.text,
    narration: split[i]?.narration ?? '',
    speech: split[i]?.speech ?? '',
    dialogueShare: split[i]?.dialogueShare ?? 0,
  }));
  const cues = direct(list);
  return lines.map((l, i) => {
    const base = cues[i] ?? { mood: 'calm' as const, dialogue: false };
    const annotated = (l.style && STYLE_MOOD[l.style]) || (l.emotion && EMOTION_MOOD[l.emotion]) || undefined;
    const cue: Cue = annotated ? { ...base, mood: annotated, explicit: true } : base;
    const say = nanoText(l.text, cue);
    const delivery: DeliveryJson = { ...deliveryParams(cue), ...(say !== l.text ? { say } : {}), ...speechShape(say) };
    const side = (k: number): PauseSide | undefined => {
      const line = lines[k];
      if (!line) return undefined;
      const t = line.text.replace(/\[[a-z ]+\]\s*/gi, '').trim();
      const command = k === i && cue.line === 'commanding' && (split[k]?.speech.match(/\p{L}[\p{L}'’]*/gu) ?? []).length <= 2;
      return { block: k, kind: 'text', startsSpoken: /^["“]/.test(t), endsSpoken: /["”]$/.test(t), quoteOpen: false, command };
    };
    const own = side(i);
    const context = own ? pauseContext(own, side(i + 1)) : undefined;
    const pauseMs =
      naturalPause({
        kind: 'text',
        display: l.text,
        pauseMs: 700,
        relaxedMs: relaxedParagraphPause(l.text, split[i]?.dialogueShare ?? 0, split[i + 1]?.dialogueShare ?? 0, i === lines.length - 1),
        sameParagraphNext: false,
        ...(context ? { context } : {}),
        intense: cue.mood === 'intense',
        seed: pauseSeed(fnv24(l.text), i),
      }) + (context === 'command' ? 0 : pauseAfter(cue));
    const speaks = (k: number): boolean => (split[k]?.dialogueShare ?? 0) > 0;
    const breath =
      i + 1 < lines.length ? breathPoint({ block: i, kind: 'text', speaks: speaks(i) }, { block: i + 1, kind: 'text', speaks: speaks(i + 1), continuesQuote: false }, pauseMs) : undefined;
    return { mood: cue.mood, line: lineClass(cue), dialogue: cue.dialogue, delivery, pauseMs, ...(breath ? { breath } : {}) };
  });
}
