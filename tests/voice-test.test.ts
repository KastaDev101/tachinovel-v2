import { describe, expect, it } from 'vitest';
import { summarize, TEST_PASSAGE } from '../src/ui/native/voice-test.ts';

describe('Settings › Voices › Voice test (src/ui/native/voice-test.ts)', () => {
  it('says a clean run is clean, in plain words', () => {
    const lines = summarize({
      ended: true, firstAudioMs: 1200, crashesDuringTest: 0, thermalStart: 'nominal', thermalEnd: 'fair',
      flow: { perAudioSecond: { call: 0.1 } }, listen: { breaks: 0, breakSeconds: 0, otherVoiceSentences: 0 },
    });
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines.map((l) => l.text)).toContain('Speed: 10.0× real time (goal 8×).');
  });

  it('flags breaks, another voice, slow speed, crashes and a stopped test', () => {
    const lines = summarize({
      ended: false, firstAudioMs: 4000, crashesDuringTest: 1, thermalStart: 'fair', thermalEnd: 'serious',
      flow: { perAudioSecond: { call: 0.5 } }, listen: { breaks: 2, breakSeconds: 3.4, otherVoiceSentences: 3 },
    });
    const bad = lines.filter((l) => !l.ok).map((l) => l.text);
    expect(bad).toEqual(expect.arrayContaining(['2 breaks (3.4 s of waiting).', 'Another voice read 3 sentences.', 'Speed: 2.0× real time (goal 8×).',
      'Started 4.0 s after the tap.', '1 crash during the test.', 'Phone heat: fair → serious.', 'The test was stopped before the end.']));
  });

  it('the passage exercises the long paragraphs, dialogue, "…" and a system line', () => {
    expect(TEST_PASSAGE.some((p) => p.length > 300)).toBe(true);
    expect(TEST_PASSAGE.some((p) => p.includes('…'))).toBe(true);
    expect(TEST_PASSAGE.some((p) => p.startsWith('[System'))).toBe(true);
    expect(TEST_PASSAGE.some((p) => p.startsWith('“'))).toBe(true);
  });
});
