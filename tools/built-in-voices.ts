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
