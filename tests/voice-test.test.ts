import { describe, expect, it } from 'vitest';
import { chipSummary, combinedReport, statusLines, studioKnown, studioLines, summarize, TEST_PASSAGE } from '../src/ui/native/voice-test.ts';

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

  it('says what the studio speed test found, against live reading’s 1.5×', () => {
    const fast = studioLines({
      ran: true, timesRealTime: 2.34, bypassed: false, thermalBefore: 0, thermalAfter: 1, enabled: true,
      placement: { 'blueprint.ane': 40, 'vocoder.ane': 90, 'vocoder.cpu': 10 },
    });
    expect(fast).toEqual([
      { ok: true, text: 'Studio: 2.3× real time — fast enough for live reading.' },
      { ok: true, text: 'Chips: blueprint 100% Neural Engine; vocoder 90% Neural Engine, 10% CPU.' },
      { ok: true, text: 'Studio heat: nominal → fair.' },
      { ok: true, text: 'Studio is on for Nephis.' },
    ]);
    const slow = studioLines({ ran: true, timesRealTime: 1.2, bypassed: true, thermalBefore: 1, thermalAfter: 2, placement: {} });
    expect(slow.filter((l) => !l.ok).map((l) => l.text)).toEqual([
      'Studio: 1.2× real time — too slow for live reading (needs 1.5×).',
      'The phone was too hot, so the studio stepped aside.',
      'Studio heat: fair → serious.',
    ]);
    expect(slow.map((l) => l.text)).toContain('Studio is off: Listen doesn’t use it.');
    // A pack without a studio is fine; any other refusal is worth a look.
    expect(studioLines({ ran: false, error: 'The installed Nephis pack has no studio (Models/nephis-studio).' })).toEqual([
      { ok: true, text: 'Studio: this pack has none, nothing to time.' },
    ]);
    expect(studioLines({ ran: false, error: 'studio.json is missing.' })).toEqual([{ ok: false, text: 'Studio test failed: studio.json is missing.' }]);
    expect(studioLines({})[0]?.ok).toBe(false);
    expect(chipSummary(undefined)).toBe('');
  });

  it('the status block names the pack and the studio state; native’s word wins over what the phone remembers', () => {
    const unknown = { has: null, on: null };
    expect(statusLines(undefined, unknown)).toEqual(['Nephis pack: this app version doesn’t say which.', 'Her studio: the test checks whether this pack has one.']);
    expect(statusLines(null, studioKnown(null, { has: true, on: true }))).toEqual([
      'Nephis pack: none installed (she reads with the voice the app came with).',
      'Her studio: not in this pack.',
    ]);
    const pack = { name: 'nephis-r9', made: '2026-10-11', studio: true, studioOn: false };
    expect(statusLines(pack, studioKnown(pack, { has: false, on: true }))).toEqual([
      'Nephis pack: nephis-r9 (made 2026-10-11).',
      'Her studio: in this pack.',
      'Studio: off.',
    ]);
    // A build that names the pack but not the studio: the last test on this phone fills in.
    expect(studioKnown({ name: 'x' }, { has: true, on: true })).toEqual({ has: true, on: true });
    expect(statusLines({ name: 'x' }, { has: true, on: true })[2]).toBe('Studio: on (she reads at 44.1 kHz).');
  });

  it('copies one report: app, device, pack, the studio and the listening test, with the notes', () => {
    const r = combinedReport({
      status: { app: '2.0.0 (8)', device: { thermal: 'fair' }, nephisPack: { name: 'nephis-r9' } },
      studio: { has: true, on: true },
      studioTest: { ran: true, timesRealTime: 2 },
      voiceTest: { kind: 'voice-test', ended: true },
      notes: '  a click at 0:40 ',
      at: '2026-10-12T00:00:00Z',
    });
    expect(r).toEqual({
      kind: 'nephis-test', at: '2026-10-12T00:00:00Z', app: '2.0.0 (8)', device: { thermal: 'fair' }, pack: { name: 'nephis-r9' },
      studio: { has: true, on: true, test: { ran: true, timesRealTime: 2 } }, voiceTest: { kind: 'voice-test', ended: true }, notes: 'a click at 0:40',
    });
    const bare = combinedReport({ status: {}, studio: { has: null, on: null }, studioTest: null, voiceTest: null, notes: ' ' });
    expect(bare.pack).toBe('not reported');
    expect(bare.notes).toBeNull();
  });
});
