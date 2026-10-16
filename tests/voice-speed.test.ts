import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aboutLines, speedLines, stageRows } from '../src/ui/native/voice-speed.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

/** A report as VoiceSpeedTest.swift answers it (pack 18, studio on, every call through her studio). */
const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'voice-speed-test',
  ran: true,
  error: null,
  keepsUp: true,
  breaks: 0,
  breakSeconds: 0,
  failedCalls: 0,
  firstAudioMs: 1840,
  audioSeconds: 46.2,
  renderSeconds: 21.4,
  timesRealTime: 2.16,
  stages: {
    pocketGenerationMs: 9800, analysisMs: 600, recognizeMs: 0, mimiDecodeMs: 2100, studioBlueprintMs: 3300, studioVocoderMs: 5200,
    studioRestMs: 100, eqPostMs: 240,
  },
  studio: { read: true, calls: 5, used: 5, skipped: 0, reasons: {}, everyCall: true, studioEQCalls: 5 },
  chain: { clipFrames: 113, carryFrames: 12, studioEQPresent: true },
  slowestCall: { n: 2, x: 1.4, totalMs: 9000, audioS: 12.6, studio: 'used' },
  device: { model: 'iPhone17,3', ios: '26.6.1', lowPower: false, thermalStart: 'nominal', thermalEnd: 'fair', memoryStart: { freeMB: 2210.4 } },
  pack: { installed: true, name: 'Nephis narrator (clear, deeper)', weightsSha256: '17304f8de9e678571194205f6fc85eb54699cd9fddb248fd444cf0de043e3b27' },
  audioSamples: 2_037_420,
  saved: 'in TachiNovel-Diagnostics',
  ...over,
});

describe('Voice speed test (voice-speed.ts)', () => {
  it('says in plain words whether she keeps up, how fast she starts and whether her studio ran on every call', () => {
    const lines = speedLines(report());
    expect(lines.map((l) => l.text)).toEqual([
      'Keeps up: yes. Every part was ready before the one before it finished playing.',
      'First audio after 1.8 s.',
      'Speed: 2.2× real time (46.2 s of audio in 21.4 s).',
      'Her studio rendered all 5 calls.',
      'The pack’s studio EQ ran on 5 calls.',
      'Slowest call: #2 at 1.4× real time (12.6 s of audio).',
      'Phone heat: nominal → fair.',
      'Saved in TachiNovel-Diagnostics.',
    ]);
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it('flags breaks, studio skips (with the reason) and a report that stayed on the iPhone', () => {
    const lines = speedLines(
      report({
        keepsUp: false,
        breaks: 2,
        breakSeconds: 3.46,
        studio: { read: true, calls: 6, used: 4, reasons: { hurry: 1, slow: 1 }, studioEQCalls: 4 },
        device: { thermalStart: 'fair', thermalEnd: 'serious', lowPower: true },
        saved: 'on the iPhone only: no Diagnostics folder is set (Settings › Diagnostics › Diagnostics Folder)',
      }),
    );
    const text = lines.map((l) => l.text);
    expect(text[0]).toBe('Keeps up: no. Playback would have waited 2 times (3.5 s in all).');
    expect(text).toContain('Her studio rendered 4 of 6 calls (others: 1 short of audio, no time for the studio, 1 too slow).');
    expect(text).toContain('Phone heat: fair → serious, Low Power Mode on.');
    expect(lines.filter((l) => !l.ok).length).toBe(4);
    // Her studio gets every call it can afford (StudioBudget): even one call short of audio is worth a look.
    const start = speedLines(report({ studio: { read: true, calls: 6, used: 5, reasons: { hurry: 1 }, studioEQCalls: 5 } }));
    expect(start.find((l) => l.text.startsWith('Her studio rendered 5 of 6'))?.ok).toBe(false);
    // Written on the iPhone, but iCloud doesn't take it: the PC never sees it (2026-10-15).
    const stuck = speedLines(report({ saved: 'in TachiNovel-Diagnostics on this iPhone, but iCloud isn’t uploading: not enough storage' }));
    expect(stuck.find((l) => l.text.startsWith('Saved'))?.ok).toBe(false);
    const all = speedLines(report({ studio: { read: true, calls: 6, used: 6, reasons: {}, studioEQCalls: 6 } }));
    expect(all.find((l) => l.text === 'Her studio rendered all 6 calls.')?.ok).toBe(true);
  });

  it('says when it ran as the steady state (Developer: 60 s buffered) and what work the calls did', () => {
    const lines = speedLines(
      report({ mode: 'steady', bankedAtStart: 60, work: { takes: 6, leadIns: 5, listened: 5, relaxedCalls: 4, latentsPerPlayed: 1.84 } }),
    );
    expect(lines[0]).toEqual({ ok: true, text: 'Steady state: started with 60 s already buffered, the way Listen runs once it is going.' });
    expect(lines).toContainEqual({
      ok: true,
      text: 'Work: lead-ins on 5 of 5 calls, 6 takes; Mimi decoded 1.8× the audio played, 4 at background priority.',
    });
    expect(speedLines(report()).some((l) => l.text.startsWith('Steady') || l.text.startsWith('Work'))).toBe(false);
  });

  it('says why it didn’t run', () => {
    expect(speedLines({ ran: false, error: 'Choose Nephis as the voice first (Settings › Voices).' })).toEqual([
      { ok: false, text: 'Speed test not run: Choose Nephis as the voice first (Settings › Voices).' },
    ]);
    expect(speedLines({ ran: false, error: 'stopped' })[0]?.text).toBe('The speed test was stopped.');
  });

  it('lists where the time went, per second of audio', () => {
    const rows = stageRows(report());
    expect(rows.map((r) => r.label)).toEqual(['Pocket generation', 'Mimi decode', 'Studio blueprint', 'Studio vocoder', 'EQ and finishing', 'Checks and studio rest']);
    expect(rows[0]?.perSecond).toBeCloseTo(9.8 / 46.2, 5);
    expect(rows[5]?.ms).toBe(700);
    expect(stageRows({}).length).toBe(0);
  });

  it('shows the phone, the pack (with its weights hash) and the chain', () => {
    expect(aboutLines(report())).toEqual([
      'iPhone17,3 · iOS 26.6.1 · 2210 MB free',
      'Pack: Nephis narrator (clear, deeper) · weights 17304f8de9e6…',
      'Chain: clip 113, carry 12 frames, studio EQ yes',
    ]);
  });

  it('names the tuner’s finishing in the chain line when the pack has it (closeness, breath air, room)', () => {
    const chain = { clipFrames: 113, carryFrames: 12, studioEQPresent: true, closeness: { amount: 0.15 }, breathAir: null, room: { amount: 0.07, seconds: 0.35 } };
    expect(aboutLines(report({ chain }))[2]).toBe('Chain: clip 113, carry 12 frames, studio EQ yes, closeness 15%, room 7%');
  });

  it('names the de-wind cleaner in the chain line, times it as its own stage and says whether it ran on every call', () => {
    const chain = { clipFrames: 113, carryFrames: 12, studioEQPresent: true, dewind: { passes: 2, model: 'DewindNet', computeUnits: 'cpu' }, room: { amount: 0.07 } };
    const r = report({ chain, stages: { ...(report().stages as Record<string, unknown>), dewindMs: 924 }, studio: { read: true, calls: 5, used: 5, studioEQCalls: 5, dewindCalls: 5 } });
    expect(aboutLines(r)[2]).toBe('Chain: clip 113, carry 12 frames, studio EQ yes, de-wind 2 passes, room 7%');
    expect(stageRows(r).map((row) => row.label)).toEqual([
      'Pocket generation', 'Mimi decode', 'Studio blueprint', 'Studio vocoder', 'De-wind cleaner', 'EQ and finishing', 'Checks and studio rest',
    ]);
    expect(stageRows(r)[4]?.perSecond).toBeCloseTo(0.924 / 46.2, 5);
    expect(speedLines(r)).toContainEqual({ ok: true, text: 'The de-wind cleaner (2 passes) ran on all 5 calls.' });
    const missing = report({ chain, studio: { read: true, calls: 5, used: 5, studioEQCalls: 5, dewindCalls: 0, dewindNote: 'no model in the pack' } });
    expect(speedLines(missing)).toContainEqual({ ok: false, text: 'The de-wind cleaner (2 passes) ran on 0 of 5 calls (no model in the pack).' });
    expect(speedLines(report()).some((l) => l.text.includes('de-wind'))).toBe(false);
  });

  it('is one tap from Diagnostics, More › Developer, the Voice Test, the app icon and (Developer options) the Listen player’s Voice panel', () => {
    const voices = read('src/ui/native/voices-ui.ts');
    expect(voices).toContain('data-testid="voices-speed"');
    // Only openVoicePicker (Listen › Voice) shows the row, and only with Developer options on (cleanup 1, 2026-10-15).
    expect(voices.match(/\$\{SPEED_TEST_ROW\}/g)?.length).toBe(1);
    expect(voices).toContain('${isDeveloper() ? `<div class="card" style="margin-top:10px">${SPEED_TEST_ROW}</div>` : \'\'}');
    expect(voices).toContain("if (act === 'voice-speed') openVoiceSpeedTest();");
    expect(read('src/ui/native/voice-test.ts')).toContain('data-testid="voice-test-speed"');
    expect(read('src/ui/native/v1-hooks.ts')).toContain("'diagnostics-voice-speed'");
    expect(read('src/ui/native/developer-ui.ts')).toContain("row('speed', 'Voice Speed Test'");
    expect(read('src/ui/native/launch-actions.ts')).toContain("e.action !== 'voiceSpeedTest'");
    expect(read('ios/App/App/Native/Shell/DeveloperOptions.swift')).toContain('localizedTitle: "Voice Speed Test"');
    const swift = read('ios/App/App/Native/Voice/Expressive/ExpressiveVoicePlugin.swift');
    for (const m of ['voiceSpeedTest', 'voiceSpeedTestStop', 'voiceSpeedTestPlay']) expect(swift).toContain(`CAPPluginMethod(name: "${m}"`);
  });
});
