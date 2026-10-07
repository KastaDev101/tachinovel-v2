/**
 * Test material for the EXPERIMENTAL expressive voices (Voice Lab › Experimental engines, and the CI
 * benchmark via tools/expressive-fixtures.ts). Plain data + a small heuristic, no DOM, so it is unit-tested
 * on the PC (tests/expressive.test.ts) and shared by the phone test and the macOS benchmark.
 *
 * A line carries what the expressive engines can act on:
 *  - `emotion`: one of NeuTTS-2E's seven emotions (Chatterbox Nano gets the matching style tag);
 *  - `style`: extra delivery only Chatterbox has a tag for ([whispering], [dramatic], [sarcastic], [narration]);
 *  - `role`: who speaks (narrator / a male / a female character), mapped to a voice per engine;
 *  - inline sound tags in the text ([laugh], [chuckle], [sigh], [gasp], …): Chatterbox Nano performs them,
 *    the other engines get the text with the tags removed.
 *  - `natural`: natural delivery (src/core/narration/delivery.ts): the director's mood, Nano's controls and the
 *    pause after the line; native uses it when Settings › Voices › Natural delivery is on (the default).
 * All prose here is original (written for this test), not taken from a novel.
 */
import { deliverLines, type LineDelivery } from '../../core/narration/delivery.ts';

export const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised', 'disgusted'] as const;
export type Emotion = (typeof EMOTIONS)[number];
export const STYLES = ['whisper', 'dramatic', 'sarcastic', 'narration'] as const;
export type Style = (typeof STYLES)[number];
export type Role = 'narrator' | 'male' | 'female';

/** Chatterbox Nano's sound-event tags (its tokenizer's added tokens), kept inline in the text. */
export const SOUND_TAGS = ['laugh', 'chuckle', 'sigh', 'gasp', 'cough', 'sniff', 'groan', 'shush', 'clear throat'] as const;

export interface ExpressiveLine {
  text: string;
  emotion: Emotion;
  style?: Style;
  role: Role;
  natural?: LineDelivery;
}

/** The lines with their natural delivery (each line its own paragraph). */
export function withNatural(lines: readonly ExpressiveLine[]): ExpressiveLine[] {
  const natural = deliverLines(lines);
  return lines.map((l, i) => {
    const n = natural[i];
    return n ? { ...l, natural: n } : { ...l };
  });
}

export interface ExpressiveSample {
  id: 'narration' | 'dialogue' | 'long';
  title: string;
  lines: ExpressiveLine[];
}

const n = (text: string, emotion: Emotion = 'neutral', style?: Style): ExpressiveLine => ({ text, emotion, role: 'narrator', ...(style ? { style } : {}) });
const m = (text: string, emotion: Emotion, style?: Style): ExpressiveLine => ({ text, emotion, role: 'male', ...(style ? { style } : {}) });
const f = (text: string, emotion: Emotion, style?: Style): ExpressiveLine => ({ text, emotion, role: 'female', ...(style ? { style } : {}) });

export const SAMPLES: ExpressiveSample[] = [
  {
    id: 'narration',
    title: 'Narration (calm)',
    lines: [
      n('Chapter twelve. The Old Bridge.', 'neutral', 'narration'),
      n('The rain had stopped by the time Sunny reached the old bridge.'),
      n('He counted the lanterns, all three hundred and four of them, and wondered who had lit them.'),
      n('Somewhere far behind him, a bell rang three times. He walked on.'),
    ],
  },
  {
    id: 'dialogue',
    title: 'Emotional dialogue',
    lines: [
      n('The door slammed open, and Mara stormed into the workshop.', 'neutral', 'dramatic'),
      f('“You sold it? You sold my father’s compass to a stranger?”', 'angry'),
      n('Tobin raised both hands and tried to smile.'),
      m('“It was a fair price, I swear [chuckle]. Well, almost fair.”', 'happy'),
      n('She stared at him for a long moment. Then her voice dropped.'),
      f('“That compass was the only thing he left me.”', 'sad', 'whisper'),
      n('Somewhere below them, something heavy dragged across the stones.', 'fearful', 'dramatic'),
      m('“Mara… did you hear that? Tell me you heard that.”', 'fearful'),
      f('[gasp] “It’s coming from the cellar!”', 'surprised'),
      m('[sigh] “I’m sorry. I’ll get it back, I promise.”', 'sad'),
      f('“You’d better [laugh]. Now grab the lantern.”', 'happy'),
    ],
  },
  {
    id: 'long',
    title: 'Long passage (about 3 minutes)',
    lines: [
      n('Chapter three. The Lantern Market.', 'neutral', 'narration'),
      n('The market opened an hour after sunset, when the canal turned black and the first lanterns floated up from the water.'),
      n('Ilsa had been coming here since she was nine, first with her grandmother and later alone, always with the same worn purse and the same rule: look at everything, buy one thing.'),
      n('Tonight the rule felt impossible.'),
      n('Every stall seemed to glow a little brighter than usual, and the air smelled of burnt sugar, wet rope and something sharp she could not name.'),
      m('“Fresh maps!” a boy shouted from a stack of crates. “Maps of the old city, maps of the new city, maps of places that do not exist yet!”', 'happy'),
      n('She laughed despite herself and kept walking.'),
      n('Near the bridge, an old woman sold glass birds that sang when you breathed on them.'),
      f('“Careful,” the woman said, without looking up. “They remember every voice they hear.”', 'neutral', 'whisper'),
      f('“Then I had better say something nice,” Ilsa answered.', 'happy'),
      n('The bird in her palm trembled, and for a moment it hummed the first notes of a song her grandmother used to sing.'),
      n('Ilsa put it down very gently. Her hands were shaking.'),
      f('“How much?” she asked, and hated how small her voice sounded.', 'sad'),
      f('“For you? A story. A true one.”', 'neutral'),
      n('So she told the old woman about the winter the canal froze, about the skating races and the boy who fell through the ice and was pulled out laughing.'),
      n('She told her about the funeral, too, and about the empty chair that nobody moved for a year.'),
      n('When she finished, the market had grown quiet around them, as if the whole street had been listening.'),
      f('“That will do,” the old woman said softly, and wrapped the glass bird in a scrap of blue cloth.', 'sad'),
      n('A gust of wind came off the water. Somewhere a lantern went out, then another, then a whole row of them.'),
      m('“Close the stalls!” someone yelled. “The tide is turning!”', 'fearful'),
      n('People began to run. Crates toppled, coins rolled across the stones, and a dog barked at nothing at all.'),
      n('Ilsa held the little bundle against her chest and pushed through the crowd toward the bridge.'),
      n('Behind her, the old woman was laughing, a bright, clear sound that did not belong to an old woman at all.'),
      n('When Ilsa finally turned around, the stall was gone. Only the blue cloth remained, folded neatly on the wet ground.'),
      n('She walked home slowly, listening to the bird hum against her heart, and she did not look back again.'),
    ],
  },
];

for (const s of SAMPLES) s.lines = withNatural(s.lines);

export function sample(id: ExpressiveSample['id']): ExpressiveSample {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown sample ${id}`);
  return s;
}

const TAG_RE = /\[(?:laugh|chuckle|sigh|gasp|cough|sniff|groan|shush|clear throat)\]\s*/gi;

/** The text without sound tags (what engines without tags, and the ASR check, get). */
export function plainText(text: string): string {
  return text.replace(TAG_RE, '').replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

const CUES: [Emotion | Style, RegExp][] = [
  ['angry', /\b(shout(?:ed|s)?|yell(?:ed|s)?|snap(?:ped|s)?|growl(?:ed|s)?|roar(?:ed|s)?|snarl(?:ed|s)?|furious|angrily|hiss(?:ed)?)\b/i],
  ['whisper', /\b(whisper(?:ed|s|ing)?|murmur(?:ed|s)?|breathed|under (?:his|her|their) breath)\b/i],
  ['sad', /\b(sob(?:bed|s)?|cried|weep(?:s|ing)?|wept|tears?|sadly|choked|mourn(?:ed)?)\b/i],
  ['fearful', /\b(scream(?:ed|s)?|trembl(?:ed|ing|es)|terrified|afraid|frightened|panic(?:ked)?|stammer(?:ed)?)\b/i],
  ['happy', /\b(laugh(?:ed|s|ing)?|chuckl(?:ed|es|ing)|grinn?(?:ed|ing)?|beam(?:ed|ing)|cheerfully|happily)\b/i],
  ['disgusted', /\b(sneer(?:ed|s)?|disgust(?:ed)?|scoff(?:ed|s)?|grimac(?:ed|es))\b/i],
  ['sarcastic', /\b(sarcastic(?:ally)?|dryly|rolled (?:his|her|their) eyes)\b/i],
];

function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  let carry = '';
  const push = (s: string): void => {
    const t = (carry + s).trim();
    if (!t) return;
    // Tiny fragments ("Oh." "No!") merge forward, like the narration front-end does.
    if (t.length < 12) carry = `${t} `;
    else {
      out.push(t);
      carry = '';
    }
  };
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
    for (const s of seg.segment(paragraph)) push(s.segment);
  } else {
    for (const s of paragraph.match(/[^.!?…]+[.!?…]+["”’)]*\s*|[^.!?…]+$/g) ?? []) push(s);
  }
  const rest = carry.trim();
  if (rest) {
    const last = out.pop();
    out.push(last ? `${last} ${rest}` : rest);
  }
  return out;
}

/**
 * Pasted text → lines with a guessed emotion, style and speaker. Deliberately simple (a cue-word
 * heuristic, not a model): it shows what "automatic acting" could do on real chapters, and where it fails.
 */
export function annotate(text: string): ExpressiveLine[] {
  const lines: ExpressiveLine[] = [];
  let lastSpeaker: Role = 'female';
  for (const paragraph of text.split(/\n\s*\n|\r?\n/)) {
    for (const sentence of splitSentences(paragraph.trim())) {
      const quoted = /["“”]/.test(sentence);
      let emotion: Emotion = 'neutral';
      let style: Style | undefined;
      for (const [label, re] of CUES) {
        if (!re.test(sentence)) continue;
        if ((STYLES as readonly string[]).includes(label)) style ??= label as Style;
        else if (emotion === 'neutral') emotion = label as Emotion;
      }
      if (quoted && emotion === 'neutral' && /!["”]?/.test(sentence)) emotion = 'surprised';
      let role: Role = 'narrator';
      if (quoted) {
        if (/\b(she|her)\b/i.test(sentence)) role = 'female';
        else if (/\b(he|him|his)\b/i.test(sentence)) role = 'male';
        else role = lastSpeaker === 'female' ? 'male' : 'female'; // unattributed: assume turns alternate
        lastSpeaker = role;
      }
      lines.push({ text: sentence, emotion, role, ...(style ? { style } : {}) });
    }
  }
  return withNatural(lines);
}
