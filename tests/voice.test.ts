/** On-device voices: speech script (front-end + lexicon), lexicon storage in the core, model pinning, CI checks. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks, type Lexicon } from '@v1tts/frontend.ts';
import { lexiconsFor, paragraphMapper, speechScript, emptyLexiconStore } from '../src/core/narration/speech-script.ts';
import { CAR_STEPS, checkSelfTest, type SelfTestReport } from '../ci/check-voice-selftest.ts';
import { normalizeWords, wordErrorRate } from '../ci/voice-asr.ts';
import { bundlePathFor, LOCK_PATH, sha256, VOICE_COLS, VOICE_ROWS, VOICES, voiceJsonToBin, verifyInstalled, type LockFile } from '../tools/fetch-voices.ts';
import { buildFixtures } from '../tools/voice-fixtures-lib.ts';
import { VOICE_PRODUCTS } from '../tools/ios-project.ts';
import { gradeRank, groupVoices } from '../src/ui/native/voice-groups.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('speech script (v1 narration front-end → native sentences)', () => {
  const html =
    '<p>Chapter 3 - The Hall</p><p>Mr. Smith waited. Ch. 12 said nothing!!! Nephis, wait!</p><p>* * *</p><p>“Hi,” she said. Hmmm… then she left.</p><hr><p>The end.</p>';
  const lex: Lexicon = { schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] };

  it('normalizes like the PC narrator, splices lexicon phonemes for Kokoro, keeps sentence ranges', () => {
    const blocks = htmlToBlocks(html);
    const s = speechScript(blocks, { title: 'The Hall', lexicons: [lex] });
    const texts = s.items.map((i) => i.text);
    expect(texts[0]).toBe('Chapter 3. The Hall.');
    expect(s.items[0]?.kind).toBe('title');
    expect(texts.join(' ')).toContain('Mister Smith');
    expect(texts.join(' ')).toContain('Chapter 12 said nothing!');
    const nephis = s.items.find((i) => i.text.includes('Nephis'));
    expect(nephis?.runs).toEqual([{ p: 'nˈɛfɪs' }, { t: ', wait!' }]);
    // The built-in lexicon too: "Hmmm…" → "Hmm" → phonemes.
    expect(s.items.filter((i) => i.runs).map((i) => i.runs?.[0])).toEqual([{ p: 'nˈɛfɪs' }, { p: 'hˈʌm' }]);
    // Every item maps back onto its block's canonical text.
    for (const it of s.items) {
      const b = blocks[it.block];
      expect(b).toBeDefined();
      expect(it.end).toBeGreaterThan(it.start);
      expect(it.end).toBeLessThanOrEqual(b?.text.length ?? 0);
    }
  });

  it('folds scene breaks into the pause of the sentence before them', () => {
    const s = speechScript(htmlToBlocks(html));
    const beforeScene = s.items.find((i) => i.text.includes('wait!'));
    const beforeHr = s.items.find((i) => i.text.includes('she left'));
    expect(beforeScene?.pauseMs).toBe(1800);
    expect(beforeHr?.pauseMs).toBe(1800);
    expect(s.items.some((i) => /\*/.test(i.text))).toBe(false);
    expect(s.items.at(-1)?.pauseMs).toBe(700);
  });

  it('maps blocks to reader paragraphs by text (core path, no DOM)', () => {
    const blocks = htmlToBlocks('<div><p>First para here.</p><p>Second one.</p></div><p>Third.</p>');
    const map = paragraphMapper(blocks, ['First para here.', 'Second one.', 'Third.']);
    expect(blocks.map((_, i) => map(i))).toEqual([0, 1, 2]);
    const s = speechScript(blocks, { paragraphOf: map });
    expect(s.items.map((i) => i.paragraph)).toEqual([0, 1, 2]);
  });

  it('lexicons: global first, then the novel', () => {
    const store = emptyLexiconStore();
    store.global.entries.push({ match: 'Sunny', say: 'Sunny' });
    store.novels['src:novel'] = { schemaVersion: 1, entries: [{ match: 'Nephis', ipa: 'nˈɛfɪs' }] };
    expect(lexiconsFor(store, 'src:novel').map((l) => l.entries.length)).toEqual([1, 1]);
    expect(lexiconsFor(store, 'src:other')).toHaveLength(1);
  });
});

describe('bundled model pinning (tools/fetch-voices.ts)', () => {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as LockFile;

  it('pins one revision with SHA-256 for every file and every offered voice', () => {
    expect(lock.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.files.length).toBeGreaterThan(40);
    for (const f of lock.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.size).toBeGreaterThan(0);
    }
    expect(lock.files.some((f) => f.path === 'ANE/af_heart.bin')).toBe(true);
    expect(lock.voices.map((v) => v.name).sort()).toEqual(VOICES.filter((v) => v !== 'af_heart').sort());
    // The chain the app loads (FluidAudio's required v2 bundles), the G2P and the lexicon.
    for (const needed of ['ANE/KokoroVocoder.mlmodelc/coremldata.bin', 'ANE/KokoroTail_v2.mlmodelc/model.mil', 'G2PEncoder.mlmodelc/model.mil', 'us_lexicon_cache.json', 'ANE/vocab.json']) {
      expect(lock.files.some((f) => f.path === needed), needed).toBe(true);
    }
    // Never the uncompiled .mlpackage sources or superseded v1 stages (size).
    expect(lock.files.some((f) => /\.mlpackage\/|KokoroTail\.mlmodelc|KokoroNoise\.mlmodelc/.test(f.path))).toBe(false);
  });

  it('the offered voices are the app catalog (VoiceCatalog.swift)', () => {
    const swift = readFileSync(path.join(root, 'ios', 'App', 'HDVoice', 'Sources', 'HDVoiceCore', 'VoiceCatalog.swift'), 'utf8');
    const ids = [...swift.matchAll(/KokoroVoice\(id: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual([...VOICES].sort());
  });

  it('converts a Kokoro v1.0 voice JSON to the flat fp32 layout (row k = key "k+1")', () => {
    const obj: Record<string, number[]> = { embedding: [1, 2] };
    for (let r = 1; r <= VOICE_ROWS; r++) obj[String(r)] = Array.from({ length: VOICE_COLS }, (_, c) => r + c / 1000);
    const bin = voiceJsonToBin(JSON.stringify(obj));
    expect(bin.length).toBe(VOICE_ROWS * VOICE_COLS * 4);
    expect(bin.readFloatLE(0)).toBeCloseTo(1, 5);
    expect(bin.readFloatLE((VOICE_COLS + 3) * 4)).toBeCloseTo(2.003, 5);
    expect(() => voiceJsonToBin('{"1":[1]}')).toThrow(/row 1/);
  });

  it('verifies an installed folder offline (checksums + Core ML flexible shapes)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kokoro-'));
    const fake: LockFile = { ...lock, files: [{ path: 'ANE/vocab.json', size: 2, sha256: sha256('{}') }], voices: [] };
    expect(verifyInstalled(dir, fake).some((p) => p.includes('missing ANE/vocab.json'))).toBe(true);
    const p = path.join(dir, bundlePathFor('ANE/vocab.json'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{}');
    const problems = verifyInstalled(dir, fake);
    expect(problems.some((x) => x.includes('vocab'))).toBe(false);
    expect(problems.some((x) => x.includes('model.mil missing'))).toBe(true);
  });

  it('a locally fetched folder (if present) matches the lock', () => {
    const dir = path.join(root, 'ios', 'App', 'App', 'KokoroModels');
    if (!existsSync(dir)) return;
    expect(verifyInstalled(dir, lock)).toEqual([]);
  });
});

describe('CI voice checks', () => {
  it('fixtures go through the app front-end, one sentence each, lexicon runs included', () => {
    const f = buildFixtures();
    expect(f.map((x) => x.id)).toEqual(['short', 'long', 'dialogue', 'numbers', 'names', 'plain']);
    expect(f.find((x) => x.id === 'numbers')?.text).toContain('Chapter 12');
    expect(f.find((x) => x.id === 'names')?.runs?.[0]).toEqual({ p: 'nˈɛfɪs' });
    expect(f.filter((x) => x.asr).length).toBe(3);
  });

  it('word error rate', () => {
    expect(normalizeWords('“Wait,” she said — “are you sure?”')).toEqual(['wait', 'she', 'said', 'are', 'you', 'sure']);
    expect(wordErrorRate('The river was loud.', 'the river was loud')).toBe(0);
    expect(wordErrorRate('one two three four', 'one too three')).toBe(0.5);
    expect(wordErrorRate('', '')).toBe(0);
  });

  it('simulator self-test assertions', () => {
    const ev = (source: string, ok = true) => ({ source, highlighted: ok ? 'x' : '', expected: 'x', t: 0 });
    const phase = (name: string, sources: string[]) => ({
      name,
      events: sources.map((s) => ev(s)),
      sources: sources.reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}),
      highlightMatches: sources.length,
      ended: true,
      sentences: sources.length,
    });
    const car = { steps: Object.fromEntries(CAR_STEPS.map((s) => [s, { ok: true }])), gapsMs: [240], warnings: [] };
    const good: SelfTestReport = {
      ui: { sentences: 4, phases: [phase('kokoro', ['apple', 'kokoro', 'kokoro', 'kokoro']), phase('slow', ['kokoro', 'apple', 'apple', 'kokoro']), phase('fail', ['apple', 'apple', 'apple', 'apple'])], car },
      output: { renderedFrames: 240000, audibleFrames: 120000, maxRMS: 0.2, manual: true },
    };
    expect(checkSelfTest(good).problems).toEqual([]);
    expect(checkSelfTest(good).summary.join(' ')).toMatch(/car: 11\/11 steps, chapter change 240 ms/);
    const noReturn: SelfTestReport = { ...good, ui: { sentences: 4, phases: [phase('kokoro', ['kokoro']), phase('slow', ['kokoro', 'apple', 'apple']), phase('fail', ['apple'])], car } };
    expect(checkSelfTest(noReturn).problems.join(' ')).toMatch(/never took over again/);
    const silent: SelfTestReport = { ...good, output: { renderedFrames: 1000, audibleFrames: 0, maxRMS: 0, manual: true } };
    expect(checkSelfTest(silent).problems.join(' ')).toMatch(/audible/);
    // The car phase: every required step, and a crash in the phase itself.
    const noNext: SelfTestReport = { ...good, ui: { ...good.ui, sentences: 4, phases: good.ui?.phases ?? [], car: { ...car, steps: { ...car.steps, next: { ok: false, detail: 'car/2' } } } } };
    expect(checkSelfTest(noNext).problems).toEqual(['car: next failed (car/2)']);
    const crashed: SelfTestReport = { ...good, ui: { sentences: 4, phases: good.ui?.phases ?? [], car: { steps: { car: { ok: false, detail: 'boom' } }, gapsMs: [], warnings: [] } } };
    expect(checkSelfTest(crashed).problems).toContain('car: car (boom)');
    expect(checkSelfTest({ ...good, ui: { sentences: 4, phases: good.ui?.phases ?? [] } }).problems).toEqual(['car phase missing']);
  });

  it('the Xcode project links the HDVoice package and bundles KokoroModels', () => {
    const pbx = readFileSync(path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    expect(pbx).toContain('relativePath = HDVoice;');
    for (const p of VOICE_PRODUCTS) expect(pbx).toContain(`productName = ${p};`);
    expect(pbx).toMatch(/KokoroModels in Resources/);
    const pkg = readFileSync(path.join(root, 'ios', 'App', 'HDVoice', 'Package.swift'), 'utf8');
    expect(pkg).toMatch(/FluidAudio\.git", exact: "0\.17\.5"/);
  });
});

describe('voice notices in THIRD_PARTY_NOTICES.md (the Licenses screen is built from it)', () => {
  it('has Kokoro, its Core ML conversion, misaki and FluidAudio with their licenses', () => {
    const md = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const [name, license] of [['Kokoro-82M', 'Apache-2.0'], ['Kokoro Core ML conversion', 'Apache-2.0'], ['misaki', 'Apache-2.0'], ['FluidAudio', 'Apache-2.0'], ['fastcluster', 'BSD-2-Clause']] as const) {
      expect(md.replace(/\r\n/g, '\n'), name).toContain(`\n## ${name}\n\n- License: ${license}\n`);
    }
  });
});

describe('voice picker order (src/ui/native/voice-groups.ts)', () => {
  const v = (id: string, name: string, language: string, gender: 'female' | 'male', grade?: string) => ({ id, name, language, gender, blurb: '', ...(grade ? { grade } : {}) });

  it('ranks grades like VoiceCatalog.swift', () => {
    expect(gradeRank('A')).toBeGreaterThan(gradeRank('A-'));
    expect(gradeRank('B-')).toBeGreaterThan(gradeRank('C+'));
    expect(gradeRank('D-')).toBeGreaterThan(gradeRank('F+'));
    expect(gradeRank(undefined)).toBe(-1);
    const swift = readFileSync(path.join(root, 'ios', 'App', 'HDVoice', 'Sources', 'HDVoiceCore', 'VoiceCatalog.swift'), 'utf8');
    const grades = [...swift.matchAll(/KokoroVoice\(id: "([a-z_]+)".*?grade: "([^"]+)"/g)].map((m) => m[2] ?? '');
    expect(grades).toHaveLength(28);
    expect(grades.every((g) => gradeRank(g) >= 0)).toBe(true);
  });

  it('groups by accent and gender, best grade first, then by name', () => {
    const groups = groupVoices([
      v('bm_george', 'George', 'en-GB', 'male', 'C'),
      v('af_sky', 'Sky', 'en-US', 'female', 'C-'),
      v('af_heart', 'Heart', 'en-US', 'female', 'A'),
      v('am_puck', 'Puck', 'en-US', 'male', 'C+'),
      v('am_fenrir', 'Fenrir', 'en-US', 'male', 'C+'),
      v('bf_emma', 'Emma', 'en-GB', 'female', 'B-'),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['American women', 'American men', 'British women', 'British men']);
    expect(groups[0]?.voices.map((x) => x.id)).toEqual(['af_heart', 'af_sky']);
    expect(groups[1]?.voices.map((x) => x.id)).toEqual(['am_fenrir', 'am_puck']);
  });
});
