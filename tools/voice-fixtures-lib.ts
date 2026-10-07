/**
 * Fixture sentences for the CI voice check (job "voice-quality"): run through the app's own narration
 * front-end (src/core/narration/speech-script.ts: normalization, built-in + novel lexicon), so kokoro-check
 * synthesizes exactly what the app would send to Kokoro. Bundled and run by tools/voice-fixtures.ts
 * (the @v1tts alias needs the build's resolver); unit-tested in tests/voice.test.ts.
 */
import type { Lexicon } from '@v1tts/frontend.ts';
import { speechScript, type SpeechRunJson } from '../src/core/narration/speech-script.ts';

export interface VoiceFixture {
  id: string;
  label: string;
  /** What the app sends: plain text (respellings applied). */
  text: string;
  /** Lexicon phoneme overrides, when the sentence has any. */
  runs?: SpeechRunJson[];
  /** Part of the ASR round trip (word error rate) — sentences without numbers or invented names. */
  asr?: boolean;
  /** Narrator mode (speech-script.ts): all dialogue, or its parts by role; the jitter factor. */
  role?: 'dialogue';
  parts?: { role: 'narration' | 'dialogue'; text: string; runs?: SpeechRunJson[] }[];
  rate?: number;
  phrases?: { text: string; pauseMs: number }[];
}

/** A novel's lexicon, as the user would enter it (phonemes in misaki notation). */
export const FIXTURE_LEXICON: Lexicon = { schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] };

const SOURCES: { id: string; label: string; text: string; asr?: boolean }[] = [
  { id: 'short', label: 'short', text: 'Hello there.' },
  {
    id: 'long',
    label: 'long narration',
    text: 'The rain had stopped by the time we reached the old bridge, and for a moment the whole city seemed to hold its breath while the lanterns flickered along the river and the wind carried the smell of wet stone and smoke.',
    asr: true,
  },
  { id: 'dialogue', label: 'dialogue', text: '“Wait,” she said quietly, “are you sure this is the right way?”', asr: true },
  { id: 'numbers', label: 'numbers / Ch. 12', text: 'We stopped at Ch. 12 on page 304, back in 1999, about 5 km from the border.' },
  { id: 'names', label: 'lexicon names', text: 'Nephis glanced at Sunny and said, Tsk, not again.' },
  { id: 'plain', label: 'plain', text: 'The river was loud and cold beneath the old stone bridge.', asr: true },
];

export function buildFixtures(): VoiceFixture[] {
  return SOURCES.map((s) => {
    const script = speechScript([{ text: s.text, tag: 'p' }], { lexicons: [FIXTURE_LEXICON] });
    if (script.items.length !== 1) throw new Error(`fixture ${s.id} must be one sentence, got ${script.items.length}`);
    const item = script.items[0] as (typeof script.items)[number];
    return {
      id: s.id,
      label: s.label,
      text: item.text,
      ...(item.runs ? { runs: item.runs } : {}),
      ...(s.asr ? { asr: true } : {}),
      ...(item.role ? { role: item.role } : {}),
      ...(item.parts ? { parts: item.parts.map((p) => ({ role: p.role, text: p.text, ...(p.runs ? { runs: p.runs } : {}) })) } : {}),
      ...(item.rate !== undefined ? { rate: item.rate } : {}),
      ...(item.phrases ? { phrases: item.phrases } : {}),
    };
  });
}
