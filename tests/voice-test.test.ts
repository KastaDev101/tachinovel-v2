import { describe, expect, it } from 'vitest';
import { chipSummary, combinedReport, runParts, safetyLines, statusLines, studioCallLines, studioKnown, studioLines, studioReads, summarize, TEST_PASSAGE } from '../src/ui/native/voice-test.ts';
import { nephisOffLine } from '../src/ui/native/voices-ui.ts';

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

  it('says how many calls her studio rendered, why it stepped aside, and how her pieces ended', () => {
    // Every call rendered, no ending cut off, two let fade out (her studio's end guard).
    expect(studioCallLines({ studio: { calls: 15, used: 15, bypassed: 0, reasons: {} }, endings: { pieces: 40, endedAudible: 0, tailsExtended: 2 } })).toEqual([
      { ok: true, text: 'Her studio rendered all 15 of her calls.' },
      { ok: true, text: 'Endings: none of 40 was cut off.' },
      { ok: true, text: '2 endings were let fade out instead of being cut.' },
    ]);
    // Some calls were her plain sound, and the read without the guard cut 3 of 40 endings (7.5%).
    const bad = studioCallLines({
      studio: { calls: 15, used: 12, bypassed: 3, reasons: { hurry: 2, heat: 1, failed: 0 } },
      endings: { pieces: 40, endedAudible: 3, tailsExtended: 1 },
    });
    expect(bad).toEqual([
      { ok: false, text: 'Her studio rendered 12 of 15 calls; 3 were her plain sound (2 short of audio, 1 phone too hot).' },
      { ok: false, text: 'Endings: 3 of 40 were cut off while still audible (7.5%; goal under 2%).' },
      { ok: true, text: '1 ending was let fade out instead of being cut.' },
    ]);
    // Under 2% is fine; a read without the studio (no studio calls) says nothing about it; older builds say nothing.
    expect(studioCallLines({ studio: { calls: 0 }, endings: { pieces: 100, endedAudible: 1 } })).toEqual([
      { ok: true, text: 'Endings: 1 of 100 was cut off while still audible (1.0%; goal under 2%).' },
    ]);
    expect(studioCallLines({})).toEqual([]);
    // In the plain-words result, after the speed.
    const lines = summarize({
      ended: true, firstAudioMs: 1200, crashesDuringTest: 0, thermalStart: 'nominal', thermalEnd: 'nominal',
      flow: { perAudioSecond: { call: 0.1 }, studio: { calls: 4, used: 4 }, endings: { pieces: 10, endedAudible: 0 } },
      listen: { breaks: 0, breakSeconds: 0, otherVoiceSentences: 0 },
    }).map((l) => l.text);
    expect(lines.slice(2, 5)).toEqual(['Speed: 10.0× real time (goal 8×).', 'Her studio rendered all 4 of her calls.', 'Endings: none of 10 was cut off.']);
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
    // Refused for lack of memory (crash plan a1): not run, native's own words with the number.
    const why = 'Not enough memory for the studio test: 226 MB free, it needs about 1,000 MB. Swipe TachiNovel away, open it again and run the test.';
    expect(studioLines({ ran: false, refused: true, error: why })).toEqual([{ ok: false, text: `Studio test not run: ${why}` }]);
    // Where the chips run comes from its own check now, merged in when asked for.
    expect(studioLines({ ran: true, timesRealTime: 2, enabled: false }).some((l) => l.text.startsWith('Chips:'))).toBe(false);
  });

  it('runs the studio test, then the listening test, in that order (crash plan a2)', async () => {
    const order: string[] = [];
    const parts = (studio: boolean, going = (): boolean => true): Parameters<typeof runParts>[0] => ({
      studio,
      studioTest: () => Promise.resolve(void order.push('studio test')),
      listen: () => Promise.resolve(void order.push('listen')),
      going,
    });
    // Native's studio test frees its own studio and returns with Nephis warm: the listening test starts as Listen does.
    expect(await runParts(parts(true))).toBe(true);
    expect(order).toEqual(['studio test', 'listen']);
    // No studio in this pack: only the listening test.
    order.length = 0;
    expect(await runParts(parts(false))).toBe(true);
    expect(order).toEqual(['listen']);
    // Stopped during the studio test: no listening test.
    order.length = 0;
    expect(await runParts(parts(true, () => false))).toBe(false);
    expect(order).toEqual(['studio test']);
  });

  it('says when her model wasn’t loaded for lack of memory, and counts low memory as a studio reason', () => {
    const why = 'Not enough memory to load Nephis: 640 MB free, she needs about 700 MB. Another voice reads meanwhile.';
    const lines = summarize({ ended: true, flow: { memory: { refusals: 1, lastRefusal: why } }, listen: {} });
    expect(lines).toContainEqual({ ok: false, text: why });
    expect(summarize({ ended: true, flow: { memory: { refusals: 0, lastRefusal: null } } }).some((l) => l.text.startsWith('Not enough memory'))).toBe(false);
    expect(studioCallLines({ studio: { calls: 6, used: 4, reasons: { memory: 2 } } })).toEqual([
      { ok: false, text: 'Her studio rendered 4 of 6 calls; 2 were her plain sound (2 low memory).' },
    ]);
    // Her studio's models still loading in the background (calls never wait for them).
    expect(studioCallLines({ studio: { calls: 6, used: 5, reasons: { loading: 1 } } })[0]?.text).toContain('(1 still loading)');
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
      'Nephis pack in use: nephis-r9 (made 2026-10-11).',
      'Her studio: in this pack.',
      'Studio: off.',
    ]);
    // A build that names the pack but not the studio: the last test on this phone fills in.
    expect(studioKnown({ name: 'x' }, { has: true, on: true })).toEqual({ has: true, on: true });
    expect(statusLines({ name: 'x' }, { has: true, on: true })[2]).toBe('Studio: on (she reads at 44.1 kHz).');
  });

  it('records 32-bit float only when her studio reads; every other read keeps the 16-bit WAV', () => {
    const nephis = { listenEngine: 'pocket-tts', pocketVoice: 'nephis' };
    expect(studioReads({ has: true, on: true }, nephis)).toBe(true);
    // Studio off, not in the pack, or unknown: v4.2 Nephis.
    expect(studioReads({ has: true, on: false }, nephis)).toBe(false);
    expect(studioReads({ has: false, on: null }, nephis)).toBe(false);
    expect(studioReads({ has: null, on: null }, nephis)).toBe(false);
    expect(studioReads({ has: true, on: null }, nephis)).toBe(false);
    // Studio on, but another voice reads: the Narrator, Kokoro (listenEngine null), Chatterbox; or no settings at all.
    expect(studioReads({ has: true, on: true }, { listenEngine: 'pocket-tts', pocketVoice: 'narrator' })).toBe(false);
    expect(studioReads({ has: true, on: true }, { listenEngine: null, pocketVoice: 'nephis' })).toBe(false);
    expect(studioReads({ has: true, on: true }, { listenEngine: 'chatterbox-nano', pocketVoice: 'nephis' })).toBe(false);
    expect(studioReads({ has: true, on: true }, undefined)).toBe(false);
    expect(studioReads({ has: true, on: true }, null)).toBe(false);
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
      kind: 'nephis-test', at: '2026-10-12T00:00:00Z', app: '2.0.0 (8)', device: { thermal: 'fair' }, pack: { name: 'nephis-r9' }, safety: null,
      studio: { has: true, on: true, test: { ran: true, timesRealTime: 2 } }, voiceTest: { kind: 'voice-test', ended: true }, notes: 'a click at 0:40',
    });
    const bare = combinedReport({ status: {}, studio: { has: null, on: null }, studioTest: null, voiceTest: null, notes: ' ' });
    expect(bare.pack).toBe('not reported');
    expect(bare.notes).toBeNull();
    // Her safety switch goes into the report as native says it.
    const crashes = { total: 2, consecutive: 0, disabled: false, notCounted: 3 };
    expect(combinedReport({ status: { crashes }, studio: { has: null, on: null }, studioTest: null, voiceTest: null, notes: '' }).safety).toEqual(crashes);
  });

  it('says in plain words whether Nephis is switched off, her last cut-off and how the app last closed', () => {
    // Switched off by two real crashes of her model: why, and the last one.
    const off = safetyLines({
      total: 2, consecutive: 2, disabled: true, notCounted: 1,
      offLine: 'Nephis was switched off after crashing twice in a row, last at 2:32 PM, chapter 1026, phone warm.',
      lastEnd: { kind: 'crashed', counted: true, inFlight: true, line: 'Nephis crashed at 2:32 PM, chapter 1026, phone warm.' },
      appLastEnd: { kind: 'unexpected', line: 'The app closed unexpectedly at 2:32 PM, chapter 1026, phone warm.' },
    });
    expect(off.off).toBe('Nephis was switched off after crashing twice in a row, last at 2:32 PM, chapter 1026, phone warm.');
    expect(off.lines).toEqual([
      { ok: false, text: 'Her last cut-off: Nephis crashed at 2:32 PM, chapter 1026, phone warm.' },
      { ok: false, text: 'Last time the app closed: The app closed unexpectedly at 2:32 PM, chapter 1026, phone warm.' },
    ]);
    // iOS closed the app for memory mid-call: on, and why it wasn't held against her.
    const memory = safetyLines({
      disabled: false,
      lastEnd: { kind: 'memory', counted: false, line: 'Closed in the background for memory at 2:32 PM, chapter 1026, phone warm. Not counted against Nephis.' },
      appLastEnd: { kind: 'closed', line: 'The app was closed at 9:05 AM (swiped away, or closed by iOS).' },
    });
    expect(memory).toEqual({
      off: null,
      lines: [
        { ok: true, text: 'Her last cut-off: Closed in the background for memory at 2:32 PM, chapter 1026, phone warm. Not counted against Nephis.' },
        { ok: true, text: 'Last time the app closed: The app was closed at 9:05 AM (swiped away, or closed by iOS).' },
      ],
    });
    // An app bug while her model loaded (the Oct 9 crash): not held against her, and the app's crash is worth a look.
    const appBug = safetyLines({
      disabled: false,
      lastEnd: { kind: 'appError', counted: false, line: 'The app crashed at 10:51 AM (an app bug). Not counted against Nephis.', signal: 'SIGABRT on the main thread' },
      appLastEnd: { kind: 'appError', line: 'The app crashed at 10:51 AM (an app bug).' },
    });
    expect(appBug.lines).toEqual([
      { ok: true, text: 'Her last cut-off: The app crashed at 10:51 AM (an app bug). Not counted against Nephis.' },
      { ok: false, text: 'Last time the app closed: The app crashed at 10:51 AM (an app bug).' },
    ]);
    // iOS stopped the app while in use (no crash) or the phone restarted.
    expect(safetyLines({ appLastEnd: { kind: 'stopped', line: 'The app was closed without crashing at 2:31 PM (by iOS, or swiped away).' } }).lines[0]?.ok).toBe(false);
    expect(safetyLines({ appLastEnd: { kind: 'restarted', line: 'The phone restarted or ran out of power after 2:32 PM.' } }).lines[0]?.ok).toBe(true);
    // Older builds: only the switch, in the old words; nothing at all without a report.
    expect(safetyLines({ total: 2, consecutive: 2, disabled: true, lastContext: 'x' })).toEqual({ off: 'Nephis was switched off after crashing twice in a row.', lines: [] });
    expect(safetyLines(undefined)).toEqual({ off: null, lines: [] });
    expect(safetyLines({ appLastEnd: null, lastEnd: null })).toEqual({ off: null, lines: [] });
  });

  it('Settings › Voices offers “Turn Nephis back on” only while she is switched off', () => {
    expect(nephisOffLine({ nephisOff: true, nephisOffLine: 'Nephis was switched off after crashing twice in a row, last at 2:32 PM.' })).toBe(
      'Nephis was switched off after crashing twice in a row, last at 2:32 PM.',
    );
    expect(nephisOffLine({ nephisOff: true, nephisOffLine: null })).toBe('Nephis was switched off after crashing twice in a row.');
    expect(nephisOffLine({ nephisOff: false, nephisOffLine: 'stale' })).toBeNull();
    expect(nephisOffLine({})).toBeNull();
    expect(nephisOffLine(undefined)).toBeNull();
  });
});
