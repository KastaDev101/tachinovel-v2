/** Experimental expressive voices (docs/expressive-tts.md): model pinning, samples, the emotion heuristic, wiring. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markdown, werFor, type BenchReport } from '../ci/expressive-bench-report.ts';
import { annotate, EMOTIONS, plainText, SAMPLES, SOUND_TAGS, STYLES } from '../src/ui/native/expressive-samples.ts';
import { buildExpressiveFixtures } from '../tools/expressive-fixtures.ts';
import { ENGINES, FLUIDAUDIO_VERSION, readLock, SWIFT_PATH, swiftSource, validateLock } from '../tools/expressive-models.ts';
import { EXPRESSIVE_PRODUCTS, updateProject, validateProject } from '../tools/ios-project.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

describe('pinned expressive models', () => {
  const lock = readLock();

  it('is a valid lock: commit revisions, SHA-256 per file, safe paths, no non-commercial license', () => {
    expect(validateLock(lock)).toEqual([]);
    expect(lock.engines.map((e) => e.id).sort()).toEqual(ENGINES.map((e) => e.id).sort());
    for (const e of lock.engines) {
      const spec = ENGINES.find((s) => s.id === e.id);
      expect(e.revision).toBe(spec?.revision);
      expect(e.files.every((f) => spec?.include(f.path))).toBe(true);
    }
  });

  it('has a Swift twin that matches the JSON exactly', () => {
    expect(readFileSync(SWIFT_PATH, 'utf8')).toBe(swiftSource(lock));
  });

  it('matches the FluidAudio loaders: the models each manager requires are in the lock', () => {
    const paths = (id: string): string[] => lock.engines.find((e) => e.id === id)?.files.map((f) => f.path) ?? [];
    const has = (id: string, prefix: string): boolean => paths(id).some((p) => p.startsWith(prefix));
    for (const m of ['T3Nano-Prefill-T512-M1536-fp16.mlmodelc/', 'T3Nano-Decode-M1536-fp16-stateful.mlmodelc/', 'FlowMean-N500-fp16.mlmodelc/', 'HiFT-T1000-fp16.mlmodelc/', 'tables/voice-default.safetensors', 'tokenizer/added_tokens.json']) {
      expect(has('chatterbox-nano', m), m).toBe(true);
    }
    for (const m of ['LM-Prefill-T768-M2048-fp16.mlmodelc/', 'LM-Decode-M2048-fp16-stateful.mlmodelc/', 'NeuCodec-Decoder-fp16.mlmodelc/', 'tokenizer.json', 'samples/emily.json', 'LICENSE']) {
      expect(has('neutts-2e', m), m).toBe(true);
    }
    for (const m of ['v2.1/english/flowlm_step_ane.mlmodelc/', 'v2.1/english/mimi_decoder.mlmodelc/', 'v2.1/english/constants_bin/alba.safetensors']) {
      expect(has('pocket-tts', m), m).toBe(true);
    }
    // Every Core ML bundle is complete (compiled model + weights).
    for (const e of lock.engines) {
      const bundles = new Set(e.files.map((f) => /^(.*\.mlmodelc)\//.exec(f.path)?.[1]).filter((b): b is string => !!b));
      for (const b of bundles) {
        expect(paths(e.id), `${e.id}: ${b}`).toEqual(expect.arrayContaining([`${b}/coremldata.bin`, `${b}/model.mil`, `${b}/weights/weight.bin`]));
      }
    }
  });

  it('uses the same vendored FluidAudio as HDVoice (one copy in the app), at the version the model sets match', () => {
    const dep = (rel: string): string | undefined => /\.package\(path: "([^"]+\/FluidAudio)"\)/.exec(read(rel))?.[1];
    expect(dep('ios/App/ExpressiveVoice/Package.swift')).toBe('../Vendor/FluidAudio');
    expect(dep('ios/App/HDVoice/Package.swift')).toBe('../Vendor/FluidAudio');
    expect(read('ios/App/Vendor/FluidAudio/Package.swift')).toContain(`FluidAudio ${FLUIDAUDIO_VERSION} (Apache-2.0`);
  });

  it('agrees with the Swift engine catalog', () => {
    const swift = read('ios/App/ExpressiveVoice/Sources/ExpressiveCore/ExpressiveCatalog.swift');
    const ids = [...swift.matchAll(/case \w+ = "([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(lock.engines.map((e) => e.id).sort());
    // The app offers all three; Pocket TTS (the Narrator voice, CPU/Neural Engine) is the default Listen engine.
    expect(lock.engines.filter((e) => e.inApp).map((e) => e.id).sort()).toEqual(['chatterbox-nano', 'neutts-2e', 'pocket-tts']);
  });
});

describe('samples (Voice Lab + CI benchmark)', () => {
  it('only uses emotions, styles and roles the engines understand', () => {
    for (const s of SAMPLES) {
      for (const l of s.lines) {
        expect(EMOTIONS).toContain(l.emotion);
        if (l.style) expect(STYLES).toContain(l.style);
        expect(['narrator', 'male', 'female']).toContain(l.role);
        // Only Chatterbox Nano's sound tags appear inline.
        for (const m of l.text.matchAll(/\[([^\]]+)\]/g)) expect(SOUND_TAGS as readonly string[]).toContain(m[1]);
      }
    }
  });

  it('has an emotional dialogue with real acting to compare', () => {
    const d = SAMPLES.find((s) => s.id === 'dialogue');
    expect(new Set(d?.lines.map((l) => l.emotion)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(d?.lines.map((l) => l.role))).toEqual(new Set(['narrator', 'male', 'female']));
    expect(d?.lines.some((l) => /\[(laugh|chuckle|sigh|gasp)\]/.test(l.text))).toBe(true);
    // The long passage is about three minutes of speech (~150 words a minute).
    const words = SAMPLES.find((s) => s.id === 'long')?.lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0) ?? 0;
    expect(words).toBeGreaterThan(380);
  });

  it('strips sound tags for engines without them', () => {
    expect(plainText('“It was a fair price, I swear [chuckle]. Well, almost fair.”')).toBe('“It was a fair price, I swear. Well, almost fair.”');
    expect(plainText('[gasp] “It’s coming from the cellar!”')).toBe('“It’s coming from the cellar!”');
    expect(plainText('[sigh] fine [clear throat] then.')).toBe('fine then.');
  });

  it('builds benchmark fixtures with unique ids and tag-free ASR references', () => {
    const { lines } = buildExpressiveFixtures();
    expect(lines.length).toBe(SAMPLES.reduce((n, s) => n + s.lines.length, 0));
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    expect(lines.every((l) => !l.plain.includes('['))).toBe(true);
  });
});

describe('annotate (pasted text → guessed acting)', () => {
  it('guesses emotions from cue words and speakers from pronouns', () => {
    const lines = annotate(
      'The hall was silent.\n\n“Get out!” she shouted.\n“I’m sorry,” he whispered.\n“Ha, you should see your face,” he laughed.\n“No… please,” she sobbed.',
    );
    expect(lines.map((l) => [l.role, l.emotion, l.style ?? null])).toEqual([
      ['narrator', 'neutral', null],
      ['female', 'angry', null],
      ['male', 'neutral', 'whisper'],
      ['male', 'happy', null],
      ['female', 'sad', null],
    ]);
  });

  it('marks unattributed exclamations as surprised and alternates unattributed speakers', () => {
    const lines = annotate('“Look out, the bridge is falling!”\n“Run, now, before it is too late.”');
    expect(lines[0]?.emotion).toBe('surprised');
    expect(lines.map((l) => l.role)).toEqual(['male', 'female']);
  });

  it('merges tiny fragments forward and keeps every word', () => {
    const text = 'Oh. No! The door opened slowly, and nobody was there.';
    const lines = annotate(text);
    expect(lines.length).toBe(1);
    expect(lines.map((l) => l.text).join(' ')).toBe(text);
  });
});

describe('benchmark report (CI)', () => {
  const report: BenchReport = {
    engine: 'chatterbox-nano',
    title: 'Chatterbox Nano',
    license: 'MIT',
    revision: 'x',
    modelBytes: 745_800_000,
    loadMs: 5000,
    warm: { loadMs: 800 },
    firstLine: { firstAudioMs: 900, synthMs: 900, coldStartToFirstAudioMs: 5900 },
    aggregateX: 2.5,
    p50X: 2.4,
    p10X: 1.2,
    memoryMB: { before: 50, loaded: 900, maxWhileRendering: 1100, afterUnload: 300, residentPeak: 1200 },
    lines: [
      { id: 'narration-01', sample: 'narration', emotion: 'neutral', chars: 30, synthMs: 900, firstAudioMs: 900, audioMs: 2000, x: 2.2 },
      { id: 'dialogue-02', sample: 'dialogue', emotion: 'angry', chars: 60, synthMs: 1000, firstAudioMs: 1000, audioMs: 3000, x: 3 },
    ],
    linesTotal: 2,
    problems: [],
  };

  it('computes the word error rate per sample from the transcripts', () => {
    const fixtures = [
      { id: 'narration-01', plain: 'The rain had stopped.' },
      { id: 'dialogue-02', plain: 'You sold my father’s compass?' },
    ];
    const heard: Record<string, string> = { 'narration-01': 'The rain had stopped.', 'dialogue-02': 'You sold my fathers compass' };
    const wer = werFor(report, fixtures, (id) => heard[id]);
    expect(wer?.checked).toBe(2);
    expect(wer?.bySample.narration).toBe(0);
    expect(wer?.bySample.dialogue).toBeCloseTo(0.2);
    expect(werFor(report, fixtures, () => undefined)).toBeUndefined();
  });

  it('renders one row per engine, failures included', () => {
    const md = markdown([
      { engine: 'chatterbox-nano', title: 'Chatterbox Nano', ok: true, report },
      { engine: 'neutts-2e', title: 'neutts-2e', ok: false, exitCode: 139 },
    ]);
    expect(md).toContain('| Chatterbox Nano | 746 MB | 5000 / 800 ms | 900 ms (cold start 5900 ms) | **2.50×** / 2.40× / 1.20× | 900 / 1100 MB | not run | 2/2 |');
    expect(md).toContain('| neutts-2e | – | **failed** (exit 139)');
  });

  it('uses the same pinned whisper.cpp as the voice-quality job', () => {
    const pins = (rel: string): string[] => ['--branch v1.9.4', 'SHA=', 'REV='].map((k) => read(rel).split('\n').find((l) => l.includes(k)) ?? `missing ${k}`);
    expect(pins('ci/expressive-asr.sh')).toEqual(pins('ci/voice-asr.sh'));
  });
});

describe('wiring', () => {
  it('registers the ExpressiveVoice package in the Xcode project', () => {
    expect(EXPRESSIVE_PRODUCTS).toEqual(['ExpressiveVoice']);
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
    expect(pbx).toContain('relativePath = ExpressiveVoice;');
    expect(pbx).toContain('productName = ExpressiveVoice;');
    expect(validateProject(pbx)).toEqual([]);
    expect(updateProject(pbx, [])).toContain('XCLocalSwiftPackageReference "ExpressiveVoice"');
  });

  it('keeps the JS plugin interface and the Swift plugin methods in sync, and registers the plugin', () => {
    const swift = read('ios/App/App/Native/Voice/Expressive/ExpressiveVoicePlugin.swift');
    const native = [...swift.matchAll(/CAPPluginMethod\(name: "([A-Za-z]+)"/g)].map((m) => m[1]).sort();
    const ts = read('src/ui/native/expressive-lab.ts');
    const iface = /interface ExpressiveVoicePlugin \{([\s\S]*?)\n\}/.exec(ts)?.[1] ?? '';
    const js = [...iface.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]).sort();
    expect(js).toEqual(native);
    expect(read('ios/App/App/Native/Shell/MainViewController.swift')).toContain('registerPluginInstance(ExpressiveVoicePlugin())');
  });

  it('keeps the experimental engines in the Voice Lab (and her download row), nowhere else', () => {
    const lab = read('src/ui/native/voice-lab.ts');
    expect(lab).toContain("import { openExpressiveLab } from './expressive-lab.ts'");
    const voices = read('src/ui/native/voices-ui.ts');
    // Nephis is the one voice (2026-10-09): Settings › Voices opens the models screen only to download her model.
    expect(voices).toContain('Download her voice');
    expect(voices).not.toContain('<b>Voice models</b>');
    for (const f of ['src/ui/native/v1-hooks.ts', 'src/ui/native/narration-overlay.ts']) {
      expect(read(f), f).not.toContain('expressive-lab');
    }
  });
});
