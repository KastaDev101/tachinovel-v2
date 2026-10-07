/**
 * Voices that ship inside the app (docs/voice-import.md): ios/App/App/BuiltInVoices/*.tnvoice + voices.json,
 * bundled as a folder (tools/ios-project.ts). The app lists them in Settings › Voices › Expressive voices like
 * imported ones (they can be the narrator voice, not renamed or deleted) and checks them with the same rules
 * as an import; voices.json names the default narrator voice for Chatterbox Nano (Chatterbox's own voice
 * stays selectable).
 *
 *   node tools/built-in-voices.ts add <file.tnvoice> [--as <name>] [--default]
 *       copy a voice made with tachinovel-narrator py/export_voice.py into the app (checked first). The file is
 *       stored as <name>.tnvoice (default: the voice's name, lowercased); keep the same name when a voice is
 *       re-tuned, so phones that chose it keep it (its id comes from the file name). --default makes it the
 *       default narrator voice.
 *   node tools/built-in-voices.ts default <name>|none      which shipped voice is the default
 *   node tools/built-in-voices.ts remove <name>
 *   node tools/built-in-voices.ts list                     names, ids, sizes; exits 1 if anything is invalid
 *
 * Redo after re-tuning a voice, in one line (from tachinovel-narrator):
 *   <lab>/.venv-chatterbox/Scripts/python.exe py/export_voice.py ref.wav --name Narrator --force \
 *       --bundle-into ../tachinovel-v2 --default
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundledVoiceId, FILE_EXTENSION, readVoicePack } from './voice-pack.ts';

const root = path.resolve(import.meta.dirname, '..');
export const BUILT_IN_VOICES_DIR = path.join(root, 'ios', 'App', 'App', 'BuiltInVoices');
export const INDEX_NAME = 'voices.json';

export interface VoicesIndex {
  schemaVersion: 1;
  /** File name of the default narrator voice, or null (Chatterbox's own voice). */
  default: string | null;
}

/** "Warm Narrator" → "warm-narrator": the bundled file's stem. */
export function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'voice'
  );
}

export function readIndex(dir = BUILT_IN_VOICES_DIR): VoicesIndex {
  const file = path.join(dir, INDEX_NAME);
  if (!existsSync(file)) return { schemaVersion: 1, default: null };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VoicesIndex>;
  return { schemaVersion: 1, default: typeof raw.default === 'string' ? raw.default : null };
}

export function writeIndex(index: VoicesIndex, dir = BUILT_IN_VOICES_DIR): void {
  writeFileSync(path.join(dir, INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`);
}

export interface ShippedVoice {
  file: string;
  id: string;
  name: string;
  bytes: number;
  hasPreview: boolean;
  isDefault: boolean;
}

/** BuiltInVoices/breaths/: the breath pack that ships with the voices. */
export const BREATHS_DIR = 'breaths';
const BREATH_MAX_BYTES = 100 * 1024;
const BREATHS_MAX_BYTES = 2 * 1024 * 1024;

/** Only `.wav` files, each a short clip, all together small. */
export function checkBreaths(dir: string): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (!f.toLowerCase().endsWith('.wav') || statSync(p).isDirectory()) {
      problems.push(`${BREATHS_DIR}/${f}: only .wav files belong in BuiltInVoices/${BREATHS_DIR}/`);
      continue;
    }
    const size = statSync(p).size;
    total += size;
    if (size > BREATH_MAX_BYTES) problems.push(`${BREATHS_DIR}/${f}: ${Math.round(size / 1024)} KB is too long for a breath`);
    if (readFileSync(p).subarray(0, 4).toString('latin1') !== 'RIFF') problems.push(`${BREATHS_DIR}/${f}: not a WAV file`);
  }
  if (total > BREATHS_MAX_BYTES) problems.push(`${BREATHS_DIR}/: ${Math.round(total / 1024)} KB in all (at most ${BREATHS_MAX_BYTES / 1024} KB)`);
  return problems;
}

/** BuiltInVoices/pocket/: the Narrator voice for Pocket TTS (ExpressiveCore/PocketVoice.swift, same rules). */
export const POCKET_DIR = 'pocket';
export const POCKET_VOICE = 'narrator.pocketvoice';
export const POCKET_MANIFEST = 'narrator.json';
const POCKET_EXT = '.pocketvoice';
const POCKET_DIM = 1024;
const POCKET_MAX_FRAMES = 125;

/** Every <name>.pocketvoice + <name>.json pair (the Narrator, and its performed read "character"); narrator required. */
export function checkPocketVoice(dir: string): string[] {
  const problems: string[] = [];
  const files = readdirSync(dir).sort();
  const names = new Set<string>();
  for (const f of files) {
    if (f.endsWith(POCKET_EXT)) names.add(f.slice(0, -POCKET_EXT.length));
    else if (f.endsWith('.json')) names.add(f.slice(0, -'.json'.length));
    else problems.push(`${POCKET_DIR}/${f}: only <name>${POCKET_EXT} + <name>.json pairs belong in BuiltInVoices/${POCKET_DIR}/`);
  }
  if (!names.has('narrator')) problems.push(`${POCKET_DIR}/: needs ${POCKET_VOICE} and ${POCKET_MANIFEST}`);
  for (const name of names) problems.push(...checkPocketPair(dir, name));
  return problems;
}

function checkPocketPair(dir: string, name: string): string[] {
  const problems: string[] = [];
  const voiceFile = `${name}${POCKET_EXT}`;
  const manifestFile = `${name}.json`;
  const where = (f: string) => `${POCKET_DIR}/${f}`;
  if (!existsSync(path.join(dir, voiceFile)) || !existsSync(path.join(dir, manifestFile))) {
    return [`${POCKET_DIR}/: ${name} needs ${voiceFile} and ${manifestFile}`];
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(readFileSync(path.join(dir, manifestFile), 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return [`${where(manifestFile)}: ${err instanceof Error ? err.message : String(err)}`];
  }
  const data = readFileSync(path.join(dir, voiceFile));
  const frames = m.frames;
  if (m.schemaVersion !== 1) problems.push(`${where(manifestFile)}: schemaVersion must be 1`);
  if (m.engine !== 'pocket-tts') problems.push(`${where(manifestFile)}: engine must be pocket-tts`);
  if (m.embeddingDim !== POCKET_DIM) problems.push(`${where(manifestFile)}: embeddingDim must be ${POCKET_DIM}`);
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > POCKET_MAX_FRAMES) {
    problems.push(`${where(manifestFile)}: frames must be 1…${POCKET_MAX_FRAMES}`);
  } else if (m.bytes !== frames * POCKET_DIM * 4 || data.length !== m.bytes) {
    problems.push(`${where(voiceFile)}: ${data.length} bytes, expected ${frames} × ${POCKET_DIM} float32`);
  }
  if (typeof m.sha256 !== 'string' || createHash('sha256').update(data).digest('hex') !== m.sha256.toLowerCase()) {
    problems.push(`${where(voiceFile)}: doesn’t match the manifest’s sha256`);
  }
  if (data.length % 4 === 0) {
    for (let i = 0; i < data.length; i += 4) {
      if (!Number.isFinite(data.readFloatLE(i))) {
        problems.push(`${where(voiceFile)}: value ${i / 4} isn’t a finite number`);
        break;
      }
    }
  }
  return problems;
}

/** Every shipped voice checked with the app's rules; problems instead of throwing (CI test + `list`). */
export function checkBuiltInVoices(dir = BUILT_IN_VOICES_DIR): { voices: ShippedVoice[]; problems: string[] } {
  const problems: string[] = [];
  const voices: ShippedVoice[] = [];
  if (!existsSync(dir)) return { voices, problems: [`${dir} is missing`] };
  let index: VoicesIndex = { schemaVersion: 1, default: null };
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, INDEX_NAME), 'utf8')) as Record<string, unknown>;
    if (raw.schemaVersion !== 1) problems.push(`${INDEX_NAME}: schemaVersion must be 1`);
    if (raw.default !== null && typeof raw.default !== 'string') problems.push(`${INDEX_NAME}: default must be a file name or null`);
    index = readIndex(dir);
  } catch (err) {
    problems.push(`${INDEX_NAME}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const file of readdirSync(dir).sort()) {
    if (file === INDEX_NAME) continue;
    // Recorded inhales for natural delivery (HybridSpeechEngine.breathPack): only small 24 kHz WAVs.
    if (file === BREATHS_DIR && statSync(path.join(dir, file)).isDirectory()) {
      problems.push(...checkBreaths(path.join(dir, file)));
      continue;
    }
    if (file === POCKET_DIR && statSync(path.join(dir, file)).isDirectory()) {
      problems.push(...checkPocketVoice(path.join(dir, file)));
      continue;
    }
    // The whole folder goes into the app: nothing else belongs here.
    if (!file.endsWith(`.${FILE_EXTENSION}`) || statSync(path.join(dir, file)).isDirectory()) {
      problems.push(`${file}: only .${FILE_EXTENSION} files and ${INDEX_NAME} belong in BuiltInVoices/`);
      continue;
    }
    try {
      const data = readFileSync(path.join(dir, file));
      const pack = readVoicePack(data);
      voices.push({ file, id: bundledVoiceId(file), name: pack.name, bytes: data.length, hasPreview: pack.preview !== null, isDefault: index.default === file });
    } catch (err) {
      problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (index.default && !voices.some((v) => v.file === index.default)) problems.push(`${INDEX_NAME}: the default “${index.default}” isn’t a valid voice here`);
  return { voices, problems };
}

export function addVoice(source: string, opts: { as?: string; makeDefault?: boolean }, dir = BUILT_IN_VOICES_DIR): ShippedVoice {
  const data = readFileSync(source);
  const pack = readVoicePack(data); // throws with the reason if the app would refuse it
  const file = `${slug(opts.as ?? pack.name)}.${FILE_EXTENSION}`;
  copyFileSync(source, path.join(dir, file));
  const index = readIndex(dir);
  if (opts.makeDefault) writeIndex({ ...index, default: file }, dir);
  else if (!existsSync(path.join(dir, INDEX_NAME))) writeIndex(index, dir);
  return { file, id: bundledVoiceId(file), name: pack.name, bytes: data.length, hasPreview: pack.preview !== null, isDefault: opts.makeDefault === true || index.default === file };
}

function fileFor(name: string): string {
  return name.endsWith(`.${FILE_EXTENSION}`) ? name : `${slug(name)}.${FILE_EXTENSION}`;
}

function main(argv: string[]): number {
  const [cmd, arg] = argv;
  const flag = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const show = (): number => {
    const { voices, problems } = checkBuiltInVoices();
    for (const v of voices) console.log(`${v.isDefault ? '*' : ' '} ${v.file}  “${v.name}”  ${v.id}  ${Math.round(v.bytes / 1024)} KB${v.hasPreview ? '' : '  (no preview)'}`);
    if (voices.length === 0) console.log('  (no shipped voices: Chatterbox’s own voice is the default)');
    for (const p of problems) console.error(`problem: ${p}`);
    return problems.length > 0 ? 1 : 0;
  };
  switch (cmd ?? '') {
    case 'add': {
      if (!arg) break;
      const v = addVoice(path.resolve(arg), { as: flag('--as'), makeDefault: argv.includes('--default') });
      console.log(`bundled ${v.file} (“${v.name}”, id ${v.id})${v.isDefault ? ' as the default narrator voice' : ''}`);
      console.log('commit ios/App/App/BuiltInVoices/ (and changelog.d) in a branch; the next build ships it.');
      return show();
    }
    case 'default': {
      if (!arg) break;
      const file = arg === 'none' ? null : fileFor(arg);
      if (file && !existsSync(path.join(BUILT_IN_VOICES_DIR, file))) {
        console.error(`no ${file} in BuiltInVoices/`);
        return 1;
      }
      writeIndex({ ...readIndex(), default: file });
      return show();
    }
    case 'remove': {
      if (!arg) break;
      const file = fileFor(arg);
      rmSync(path.join(BUILT_IN_VOICES_DIR, file), { force: true });
      const index = readIndex();
      if (index.default === file) writeIndex({ ...index, default: null });
      return show();
    }
    case 'list':
    case 'check':
      return show();
    default:
  }
  console.error('usage: node tools/built-in-voices.ts add <file.tnvoice> [--as <name>] [--default] | default <name>|none | remove <name> | list');
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
