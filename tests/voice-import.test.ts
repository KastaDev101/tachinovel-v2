/**
 * Imported voices (docs/voice-import.md): the Settings › Voices › Expressive voices UI logic
 * (src/ui/native/voice-import.ts) and the wiring between the UI, the Swift plugin, Info.plist and the
 * format constants. The .tnvoice checks themselves are Swift (ExpressiveCore VoicePack.swift) and are
 * unit-tested by ios/App/ExpressiveVoice/Tests/ExpressiveCoreTests/VoicePackTests.swift (CI voice-quality).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN,
  cleanVoiceName,
  effectiveVoice,
  importEventMessage,
  importMessage,
  normalizeVoices,
  renameProblem,
  sampleMessage,
  shortDate,
  voiceName,
  voicesSection,
  type VoicesUiState,
} from '../src/ui/native/voice-import.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const A = 'v0a1b2c3d4e5f6a7b';
const B = 'vffffeeeeddddcccc';
const S = 'b977be3f26cb8d509'; // a shipped voice ("narrator.tnvoice")
const raw = {
  engine: 'chatterbox-nano',
  engineTitle: 'Chatterbox Nano',
  importEnabled: true,
  default: S,
  selected: A,
  selectedMissing: false,
  loaded: null,
  note: null,
  list: [
    { id: S, name: 'Narrator', createdAt: '2026-10-07T07:00:00Z', hasPreview: true, bundled: true, isDefault: true },
    { id: A, name: 'Mommy', createdAt: '2026-10-06T23:50:00Z', importedAt: '2026-10-07T08:00:00Z', hasPreview: true, madeFor: 'x', sourceFile: 'Mommy.tnvoice' },
    { id: B, name: 'Knight', createdAt: '2026-10-06T23:51:00Z', importedAt: '2026-10-07T09:00:00Z', hasPreview: false, madeFor: null, sourceFile: null },
  ],
};
const ui = (over: Partial<VoicesUiState> = {}): VoicesUiState => ({ armed: '', renaming: '', renameDraft: '', ...over });

/** Visible text of an HTML fragment: everything outside <...> (test helper, not a sanitizer). */
function textOutsideTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

describe('normalizeVoices', () => {
  it('reads what native sends: shipped voices (one the default), imported ones, the choice', () => {
    const info = normalizeVoices(raw);
    expect(info?.list.map((v) => [v.id, v.name, v.hasPreview, v.bundled, v.isDefault])).toEqual([
      [S, 'Narrator', true, true, true],
      [A, 'Mommy', true, false, false],
      [B, 'Knight', false, false, false],
    ]);
    expect(info?.defaultVoice).toBe(S);
    expect(info?.selected).toBe(A);
    expect(info && effectiveVoice(info)).toBe(A);
    expect(info?.importEnabled).toBe(true);
  });

  it('uses the default voice when nothing is chosen, and Chatterbox’s own voice when nothing ships', () => {
    const none = normalizeVoices({ ...raw, selected: null });
    expect(none && effectiveVoice(none)).toBe(S);
    const old = normalizeVoices({ ...raw, selected: null, default: undefined, list: raw.list.slice(1) });
    expect(old?.defaultVoice).toBe(BUILT_IN);
    expect(old && effectiveVoice(old)).toBe(BUILT_IN);
    const chosen = normalizeVoices({ ...raw, selected: BUILT_IN });
    expect(chosen && effectiveVoice(chosen)).toBe(BUILT_IN);
    // An imported voice can't claim to be the default.
    expect(normalizeVoices({ ...raw, default: A })?.defaultVoice).toBe(BUILT_IN);
  });

  it('is null for an app without voice import (an older build, a web update on old native) or junk', () => {
    expect(normalizeVoices(undefined)).toBeNull();
    expect(normalizeVoices({})).toBeNull();
    expect(normalizeVoices('voices')).toBeNull();
    expect(normalizeVoices({ list: 'nope' })).toBeNull();
  });

  it('drops entries with ids that are not voice ids (never trusted to build anything) and duplicates', () => {
    const info = normalizeVoices({ ...raw, list: [...raw.list, { id: '../x', name: 'evil' }, { id: A, name: 'dupe' }, null, 42, { id: 'V0A1B2C3D4E5F6A7B', name: 'caps' }] });
    expect(info?.list.map((v) => v.id)).toEqual([S, A, B]);
  });

  it('cleans names and treats a selection without a file as missing (the default voice in use)', () => {
    const info = normalizeVoices({ ...raw, selected: 'v9999999999999999', list: [raw.list[0], { id: A, name: '  Warm\u0007  narrator\n' }] });
    expect(info?.list[1]?.name).toBe('Warm narrator');
    expect(info?.selectedMissing).toBe(true);
    expect(info && effectiveVoice(info)).toBe(S);
    expect(normalizeVoices({ ...raw, selected: '../../etc' })?.selected).toBeNull();
    expect(normalizeVoices({ ...raw, loaded: 'builtin' })?.loaded).toBe(BUILT_IN);
    expect(normalizeVoices({ ...raw, loaded: 'something' })?.loaded).toBeNull();
  });
});

describe('names', () => {
  it('cleans like native (VoicePack.cleanName)', () => {
    expect(cleanVoiceName('  Warm\u0007  narrator\n')).toBe('Warm narrator');
    expect(cleanVoiceName('\u202Eevil')).toBe('evil');
    expect(cleanVoiceName('')).toBe('Imported voice');
    expect(cleanVoiceName('a'.repeat(90))).toHaveLength(40);
  });

  it('refuses an empty rename', () => {
    expect(renameProblem('   ')).toBe('Type a name.');
    expect(renameProblem('Knight')).toBeNull();
  });

  it('formats dates the same everywhere (UTC)', () => {
    expect(shortDate('2026-10-07T08:00:00Z')).toBe('7 Oct 2026');
    expect(shortDate('not a date')).toBe('');
    expect(shortDate(null)).toBe('');
  });
});

describe('the Narrator voice section', () => {
  const sectionInfo = info();
  const rowIn = (html: string, id: string): string => html.split(`data-voice="${id}"`)[1]?.split('data-voice=')[0] ?? '';

  it('lists shipped voices, Chatterbox’s own voice and the imported ones; marks the narrator and the default voice', () => {
    const html = voicesSection(sectionInfo, ui());
    expect(html).toContain('data-testid="xvoices"');
    expect([...html.matchAll(/data-voice="([^"]+)"/g)].map((m) => m[1])).toEqual([S, BUILT_IN, A, B]);
    expect(rowIn(html, A)).toContain('Narrator voice');
    expect(rowIn(html, A)).not.toContain('data-act="voice-use"');
    expect(rowIn(html, S)).toContain('Default');
    expect(rowIn(html, S)).toContain('Comes with TachiNovel');
    expect(rowIn(html, BUILT_IN)).toContain('Original Chatterbox voice');
    for (const id of [S, BUILT_IN]) {
      // Shipped voices and Chatterbox's own can be chosen and heard, never renamed or deleted.
      expect(rowIn(html, id)).toContain('data-act="voice-use"');
      expect(rowIn(html, id)).toContain('data-act="voice-play"');
      expect(rowIn(html, id)).not.toContain('voice-rename');
      expect(rowIn(html, id)).not.toContain('voice-arm-delete');
    }
    expect(rowIn(html, A)).toContain('voice-rename');
    expect(rowIn(html, A)).toContain('has a preview');
    expect(rowIn(html, B)).toContain('no preview');
    expect(html).toContain('data-act="voice-import"');
  });

  it('gives every control a name (VoiceOver) and only uses buttons and a labelled field', () => {
    const html = voicesSection(sectionInfo, ui({ renaming: A, renameDraft: 'Mommy', armed: `voice-delete:${B}` }));
    for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
      const tag = m[0];
      const label = /aria-label="([^"]+)"/.exec(tag)?.[1] ?? textOutsideTags(m[1] ?? '').trim();
      expect(label, tag).not.toBe('');
      expect(tag).toContain('type="button"');
    }
    expect(html).toMatch(/<input type="text" data-act-input="voice-name" maxlength="40"[^>]*aria-label="New name for Mommy"[^>]*value="Mommy">/);
    expect(html).toContain('Tap again: delete “Knight”');
    expect(html).not.toMatch(/\shidden\b|display:\s*none/); // nothing the crawler can't operate
  });

  it('escapes names (a voice file is untrusted)', () => {
    const evil = normalizeVoices({ ...raw, list: [{ id: A, name: '<img src=x onerror=alert(1)>"' }] });
    const html = evil ? voicesSection(evil, ui()) : '';
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;');
  });

  it('says when Chatterbox Nano fell back to another voice', () => {
    const missing = normalizeVoices({ ...raw, selected: 'v9999999999999999' });
    expect(missing && voicesSection(missing, ui())).toContain('isn’t on this iPhone any more, so Chatterbox Nano uses the default voice (Narrator)');
    const note = normalizeVoices({ ...raw, note: 'Couldn’t use “Mommy”: damaged. Using “Narrator” instead.', loaded: S });
    const html = note ? voicesSection(note, ui()) : '';
    expect(html).toContain('data-testid="xvoices-note"');
    expect(html).toContain('Couldn’t use “Mommy”: damaged. Using “Narrator” instead.');
    expect(rowIn(html, S)).toContain('loaded');
  });

  it('has no Import button where import is off', () => {
    const off = normalizeVoices({ ...raw, importEnabled: false });
    const html = off ? voicesSection(off, ui()) : '';
    expect(html).not.toContain('voice-import');
    expect(html).toContain('Importing voices isn’t part of this build.');
  });
});

describe('messages', () => {
  it('after an import', () => {
    expect(importMessage({ cancelled: true })).toBe('');
    expect(importMessage({})).toBe('');
    expect(importMessage({ voice: { name: 'Mommy' }, replaced: false })).toBe('Imported “Mommy”. Tap Use to make it the narrator voice.');
    expect(importMessage({ voice: { name: 'Mommy' }, replaced: true })).toBe('“Mommy” was already imported; it kept its name.');
  });

  it('after ▶ and for "Open in TachiNovel"', () => {
    expect(sampleMessage({ played: 'preview' }, 'Mommy')).toBe('Playing the preview of “Mommy”.');
    expect(sampleMessage({ played: 'chatterbox-nano' }, 'Original Chatterbox voice')).toContain('“Original Chatterbox voice” through Chatterbox Nano');
    expect(importEventMessage({ ok: true, message: ' “Knight” imported. ' })).toEqual({ message: '“Knight” imported.', error: false });
    expect(importEventMessage({ ok: false })).toEqual({ message: 'Couldn’t import the voice.', error: true });
    expect(importEventMessage(null)).toEqual({ message: 'Couldn’t import the voice.', error: true });
    expect(voiceName(info(), B)).toBe('Knight');
    expect(voiceName(info(), null)).toBe('Narrator');
    expect(voiceName(info(), BUILT_IN)).toBe('Original Chatterbox voice');
    expect(voiceName(info(), 'v0000000000000000')).toBe('Unknown voice');
  });
});

function info(): NonNullable<ReturnType<typeof normalizeVoices>> {
  const i = normalizeVoices(raw);
  if (!i) throw new Error('fixture');
  return i;
}

describe('wiring', () => {
  const swiftFormat = read('ios/App/ExpressiveVoice/Sources/ExpressiveCore/VoicePack.swift');
  const constant = (name: string): string | undefined => new RegExp(`static let ${name} = "([^"]+)"`).exec(swiftFormat)?.[1];

  it('declares the .tnvoice document type and its exported UTI in Info.plist, matching the Swift constants', () => {
    const plist = read('ios/App/App/Info.plist');
    expect(constant('typeIdentifier')).toBe('app.tachinovel.voice');
    expect(constant('fileExtension')).toBe('tnvoice');
    expect(plist).toMatch(/<key>UTExportedTypeDeclarations<\/key>[\s\S]*<string>app\.tachinovel\.voice<\/string>[\s\S]*<key>public\.filename-extension<\/key>\s*<array>\s*<string>tnvoice<\/string>/);
    expect(plist).toMatch(/<key>CFBundleDocumentTypes<\/key>[\s\S]*<key>LSItemContentTypes<\/key>\s*<array>\s*<string>app\.tachinovel\.voice<\/string>/);
    // Conforms to plain data only (not zip): Files must not offer to unzip it.
    expect(plist).not.toMatch(/app\.tachinovel\.voice[\s\S]{0,400}public\.zip-archive/);
  });

  it('routes opened .tnvoice files to the importer, and the importer uses the picker with the same types', () => {
    expect(read('ios/App/App/SceneDelegate.swift')).toContain('if VoiceImportInbox.handles(url) { return VoiceImportInbox.open(url) }');
    const plugin = read('ios/App/App/Native/Voice/Expressive/ExpressiveVoicePlugin.swift');
    expect(plugin).toContain('types: [VoicePackFormat.typeIdentifier, VoicePackFormat.fileExtension]');
    expect(plugin).toContain('notifyListeners("voiceImport", data: data, retainUntilConsumed: true)');
  });

  it('listens for opened files only in the personal flavor', () => {
    const main = read('src/ui/main.ts');
    expect(main).toMatch(/if \(__FLAVOR__ === 'personal'\) \{[^}]*installVoiceImports\(\);/);
    // The section exists only in the personal flavor (the store flavor's bundle drops voice-import.ts).
    expect(read('src/ui/native/expressive-lab.ts')).toMatch(/const voices =\s+__FLAVOR__ === 'personal'\s+\? createVoiceSection\(/);
  });

  it('pins the voice layout to the built-in Chatterbox Nano voice (tables/voice-default.safetensors)', () => {
    // Shapes and dtypes read from FluidInference/chatterbox-nano-coreml@f28421e tables/voice-default.safetensors.
    for (const t of ['TensorSpec("t3_cond_emb", .f16, [1, 376, 768])', 'TensorSpec("prompt_token", .i32, [1, 250], intRange: 0..<6561)', 'TensorSpec("prompt_feat", .f16, [1, 500, 80])', 'TensorSpec("embedding", .f16, [1, 192])']) {
      expect(swiftFormat).toContain(t);
    }
    expect(swiftFormat).toContain('weights: "t3_nano_v1+s3gen_meanflow"');
    const lock = JSON.parse(read('ios/expressive-models.lock.json')) as { engines: { id: string; files: { path: string; size: number }[] }[] };
    const voice = lock.engines.find((e) => e.id === 'chatterbox-nano')?.files.find((f) => f.path === 'tables/voice-default.safetensors');
    // 8-byte length + 304-byte header + the four tensors: the same size an imported voice has.
    expect(voice?.size).toBe(8 + 304 + 376 * 768 * 2 + 250 * 4 + 500 * 80 * 2 + 192 * 2);
    expect(read('ios/App/ExpressiveVoice/Sources/ExpressiveCore/ImportedVoices.swift')).toContain('public static let slotPath = "tables/voice-default.safetensors"');
  });

  it('documents the format and the PC steps', () => {
    const doc = read('docs/voice-import.md');
    for (const s of ['export_voice.py', 'TachiNovel-Voices', 'manifest.json', 'voice.safetensors', 'preview.m4a', 'formatVersion', 'engineVersion', 't3_nano_v1+s3gen_meanflow']) {
      expect(doc, s).toContain(s);
    }
  });
});
