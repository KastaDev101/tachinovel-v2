/**
 * Scene-reading test scenes (original, written for TachiNovel): the paragraphs and, per sentence of the script built
 * from them, every read of the narrator voice that would be acceptable (n narrator, p performed, t tense, s sad,
 * d tender). tests/scene-reading.test.ts holds the rules to 95 %; the Voice Lab scores the on-device AI director on
 * the phone with the same scenes.
 */
import type { NarratorVoice, SpeechItem } from './speech-script.ts';

export interface SceneTest {
  name: string;
  paragraphs: readonly string[];
  labels: readonly string[];
}

export const SCENE_TESTS: readonly SceneTest[] = [
  {
    name: "merrow",
    paragraphs: [
      "The village of Merrow sat at the edge of the salt flats, where the wind never quite stopped.",
      "Every morning the baker opened his shutters at six, and every morning the same three cats waited on the step.",
      '"You\'re late," Tessa said, leaning against the counter with a grin. "Again."',
      '"I\'m never late," Corin replied. "Everyone else is just early."',
      'She laughed and tossed him an apron. "Sure. Tell that to the bread."',
      "That evening, the letter came.",
      "Corin read it twice before he understood. His brother was gone, lost at sea three weeks ago, and no one had thought to tell him until now.",
      "He sat down on the cold floor of the bakery and did not move for a long time.",
      '"I\'m so sorry," Tessa whispered, kneeling beside him. "I\'m here. You don\'t have to say anything."',
      "'He promised he'd come back...'",
      "He wept quietly into his hands, and she held him until the candles burned down.",
      "[Quest Updated: Find the Lost Ship]",
      "[Reward: Unknown]",
      "Three days later, the raiders came over the dunes.",
      "The first arrow struck the well post with a sharp crack. Then the second.",
      '"Get inside!" Corin shouted. "Now!"',
      "Tessa grabbed the children and ran for the cellar door. Behind her, the stable burst into flames.",
      "A raider lunged at Corin with a curved blade. He ducked, felt the steel hiss past his ear, and drove his shoulder into the man's chest.",
      "'Too many. There are too many of them.'",
      "Blood ran into his eyes. His arm was shaking. Somewhere to his left, a horse screamed.",
      '"Is that all you\'ve got?" the raider leader sneered, circling him slowly.',
      "Corin didn't answer. He raised the bread knife, the only weapon he had, and waited.",
      "[You have slain a Bandit Captain.]",
      "[Level Up! Strength +2]",
      "When the smoke cleared, the village was quiet again.",
      "Tessa climbed out of the cellar, her face streaked with ash. She looked at him for a long moment.",
      '"You idiot," she said softly, and then she hugged him so hard that he forgot about the pain.',
      '"Hey... it\'s alright," he murmured. "We made it. We\'re okay."',
      "The next morning, the three cats were waiting on the step, as if nothing had happened at all.",
    ],
    labels: [
      "n",
      "n",
      "pn",
      "pn",
      "p",
      "n",
      "p",
      "ns",
      "ns",
      "sn",
      "sn",
      "ds",
      "d",
      "sd",
      "sn",
      "n",
      "n",
      "tn",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "pt",
      "tn",
      "tn",
      "n",
      "n",
      "n",
      "n",
      "nd",
      "dp",
      "d",
      "dp",
      "dp",
      "n",
    ],
  },
  {
    name: "lighthouse",
    paragraphs: [
      "The lighthouse had been dark for eleven years when Mara finally climbed its stairs.",
      "Dust covered every step. The air smelled of salt and old rope.",
      "Halfway up, she heard something above her shift its weight.",
      "She stopped breathing. The sound came again, slow and deliberate, like a heel dragging across stone.",
      "'Someone's up there.'",
      '"Hello?" she called, and hated how thin her voice sounded.',
      "No answer. Only the wind, and then a soft, wet clicking that made the hair on her arms stand up.",
      "She backed down one step, then another. Something pale moved at the top of the stairwell.",
      '"Run!" Jonah screamed from the doorway below. "Mara, run!"',
      "She ran.",
      "They did not stop until the village lights were behind them and the lighthouse was only a black finger against the sky.",
      "[Hidden Area Discovered: The Drowned Light]",
      "Later, by the fire, Jonah wrapped a blanket around her shoulders.",
      '"You\'re shaking," he said gently.',
      '"I\'m fine," Mara lied.',
      "He sat down beside her and didn't say anything for a while. The fire crackled. Outside, the rain began.",
      '"I thought I\'d lost you," he finally whispered.',
      'She leaned her head against his shoulder. "You didn\'t."',
      "The next morning, Old Bess was waiting at the bakery with her arms crossed.",
      '"So," she said, raising an eyebrow. "I hear you two went ghost hunting."',
      '"It wasn\'t a ghost," Jonah muttered.',
      '"Of course not, dear," Bess chuckled. "It never is."',
      "Mara laughed despite herself and stole the last cinnamon roll from the tray.",
    ],
    labels: [
      "n",
      "n",
      "nt",
      "nt",
      "t",
      "t",
      "t",
      "tp",
      "t",
      "t",
      "t",
      "t",
      "t",
      "t",
      "tn",
      "n",
      "n",
      "dp",
      "pdt",
      "n",
      "n",
      "n",
      "d",
      "n",
      "dp",
      "n",
      "p",
      "p",
      "p",
      "pd",
      "p",
      "n",
    ],
  },
];

export type SceneKind = 'narration' | 'spoken' | 'system';

/** What each script item is, for the scene reader (system message, spoken line or thought, narration). */
export function sceneKinds(items: readonly Pick<SpeechItem, 'kind' | 'role' | 'parts' | 'voice'>[]): SceneKind[] {
  return items.map((i) => (i.kind === 'system' ? 'system' : i.role === 'dialogue' || i.parts?.some((p) => p.role === 'dialogue') ? 'spoken' : 'narration'));
}

const MOOD_READ: Readonly<Record<string, NarratorVoice | undefined>> = { tense: 'tense', intense: 'tense', dread: 'tense', sad: 'sad', tender: 'tender' };

/**
 * Reads from the on-device model's moods, as native plays them (HDVoiceCore SceneMood.swift; keep the two in
 * step): spoken lines and thoughts follow their mood (else performed); narration takes tense or sad only when a
 * neighbouring narration sentence agrees; system messages keep the script's read.
 */
export function modelVoices(items: readonly Pick<SpeechItem, 'voice'>[], kinds: readonly SceneKind[], moods: readonly string[]): (NarratorVoice | undefined)[] {
  const narrationRead = (j: number): NarratorVoice | undefined => (kinds[j] === 'narration' ? MOOD_READ[moods[j] ?? ''] : undefined);
  return items.map((it, i) => {
    if (kinds[i] === 'system' || moods[i] === undefined) return it.voice;
    const r = MOOD_READ[moods[i] ?? ''];
    if (kinds[i] === 'spoken') return r ?? 'performed';
    if (r !== 'tense' && r !== 'sad') return undefined;
    return narrationRead(i - 1) === r || narrationRead(i + 1) === r ? r : undefined;
  });
}

const CODE: Readonly<Record<string, string>> = { performed: 'p', tense: 't', sad: 's', tender: 'd' };

/** Sentences whose read is among the acceptable ones. */
export function sceneScore(voices: readonly (NarratorVoice | undefined)[], labels: readonly string[]): { ok: number; total: number; misses: number[] } {
  const misses = voices.flatMap((v, k) => ((labels[k] ?? '').includes(v ? (CODE[v] ?? '?') : 'n') ? [] : [k]));
  return { ok: voices.length - misses.length, total: voices.length, misses };
}
